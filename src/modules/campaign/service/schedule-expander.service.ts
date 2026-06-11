import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

interface TimeSlot {
  startTime: string;
  endTime: string;
}

interface ScheduleConfig {
  dayOfWeek: number;
  timeSlots: TimeSlot[];
  action: 'ENABLED' | 'PAUSED';
}

interface SyncResult {
  schedulesCreated: number;
  schedulesRemoved: number;
  jobsCreated: number;
  jobsCancelled: number;
}

@Injectable()
export class ScheduleExpanderService {
  constructor(
    private readonly em: EntityManager,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {}

  async clearAllSchedules(
    campaignId: string,
  ): Promise<{ schedulesRemoved: number; jobsCancelled: number }> {
    const em = this.em.fork();
    const existing = await this.fetchActive(em, campaignId);

    let jobsCancelled = 0;

    for (const schedule of existing) {
      const jobs = await em.find(ScheduleJob, { schedule });
      for (const job of jobs) {
        try {
          await this.schedulerQueue.remove(`schedule-${job.id}`);
        } catch { /* ignore */ }
        jobsCancelled++;
      }
      await em.nativeDelete(ScheduleJob, { schedule });
      await em.removeAndFlush(schedule);
    }

    return {
      schedulesRemoved: existing.length,
      jobsCancelled,
    };
  }

  async syncSchedules(
    campaignId: string,
    profileId: number,
    region: string,
    sessionId: string,
    incoming: ScheduleConfig[],
  ): Promise<SyncResult> {
    const em = this.em.fork();
    const existing = await this.fetchActive(em, campaignId);

    const incomingKeys = this.keySet(incoming);
    const { keep, cancel } = this.partition(existing, incomingKeys);

    const cancelled = await this.cancel(em, cancel);
    const create = this.extractNew(incoming, keep);
    const created = await this.create(em, campaignId, profileId, region, sessionId, create);

    await em.flush();

    return {
      schedulesCreated: create.length,
      schedulesRemoved: cancel.length,
      jobsCreated: created,
      jobsCancelled: cancelled,
    };
  }

  private async fetchActive(em: EntityManager, campaignId: string): Promise<CampaignSchedule[]> {
    return em.find(CampaignSchedule, { campaignId, isActive: true });
  }

  private keySet(configs: ScheduleConfig[]): Set<string> {
    const keys = new Set<string>();
    for (const cfg of configs) {
      for (const slot of cfg.timeSlots) {
        keys.add(`${cfg.dayOfWeek}|${slot.startTime}|${slot.endTime}`);
      }
    }
    return keys;
  }

  private partition(
    existing: CampaignSchedule[],
    incomingKeys: Set<string>,
  ): { keep: CampaignSchedule[]; cancel: CampaignSchedule[] } {
    const keep: CampaignSchedule[] = [];
    const cancel: CampaignSchedule[] = [];

    for (const schedule of existing) {
      const matches = (schedule.timeSlots ?? []).some(slot =>
        incomingKeys.has(`${schedule.dayOfWeek}|${slot.startTime}|${slot.endTime}`),
      );
      (matches ? keep : cancel).push(schedule);
    }

    return { keep, cancel };
  }

  private extractNew(incoming: ScheduleConfig[], keep: CampaignSchedule[]): ScheduleConfig[] {
    const keepKeys = new Set(
      keep.flatMap(s => (s.timeSlots ?? []).map(slot => `${s.dayOfWeek}|${slot.startTime}|${slot.endTime}`)),
    );

    const out: ScheduleConfig[] = [];
    for (const cfg of incoming) {
      for (const slot of cfg.timeSlots) {
        const key = `${cfg.dayOfWeek}|${slot.startTime}|${slot.endTime}`;
        if (!keepKeys.has(key)) {
          out.push({ dayOfWeek: cfg.dayOfWeek, timeSlots: [slot], action: cfg.action });
        }
      }
    }
    return out;
  }

  private async cancel(em: EntityManager, schedules: CampaignSchedule[]): Promise<number> {
    let count = 0;
    for (const schedule of schedules) {
      const jobs = await em.find(ScheduleJob, { schedule, status: 'pending' });
      for (const job of jobs) {
        try {
          await this.schedulerQueue.remove(`schedule-${job.id}`);
        } catch { /* noop */ }
        job.status = 'cancelled';
        count++;
      }
      schedule.isActive = false;
      schedule.updatedAt = new Date();
    }
    return count;
  }

  private async create(
    em: EntityManager,
    campaignId: string,
    profileId: number,
    region: string,
    sessionId: string,
    configs: ScheduleConfig[],
  ): Promise<number> {
    if (configs.length === 0) return 0;

    const jobs = this.buildJobs(em, campaignId, profileId, region, sessionId, configs);
    await em.flush();
    await this.enqueue(jobs);

    return jobs.length;
  }

  private buildJobs(
    em: EntityManager,
    campaignId: string,
    profileId: number,
    region: string,
    sessionId: string,
    configs: ScheduleConfig[],
  ): Array<{ job: ScheduleJob; delay: number }> {
    const out: Array<{ job: ScheduleJob; delay: number }> = [];

    for (const cfg of configs) {
      const schedule = em.create(CampaignSchedule, {
        campaignId,
        profileId,
        region,
        sessionId,
        dayOfWeek: cfg.dayOfWeek,
        timeSlots: cfg.timeSlots,
        action: cfg.action,
        isActive: true,
      });
      em.persist(schedule);

      const { startAction, endAction } = this.resolveActions(cfg.action);

      for (const slot of cfg.timeSlots) {
        const { startAt, endAt } = this.nextOccurrenceInPST(cfg.dayOfWeek, slot);

        out.push(
          {
            job: this.makeJob(em, schedule, campaignId, profileId, region, startAt, 'slot_start', startAction),
            delay: startAt.getTime() - Date.now()
          },
          {
            job: this.makeJob(em, schedule, campaignId, profileId, region, endAt, 'slot_end', endAction),
            delay: endAt.getTime() - Date.now()
          },
        );
      }
    }

    return out;
  }

  private nextOccurrenceInPST(
    dayOfWeek: number,
    slot: TimeSlot,
  ): { startAt: Date; endAt: Date } {
    const timeZone = 'America/Los_Angeles';

    // Get current PST date components (works regardless of server timezone)
    const now = new Date();
    const pstParts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false,
    }).formatToParts(now);

    const get = (type: string) => Number(pstParts.find(p => p.type === type)?.value ?? 0);

    const pstYear = get('year');
    const pstMonth = get('month');
    const pstDay = get('day');
    const pstHour = get('hour');
    const pstMin = get('minute');

    // Get PST day of week
    const currentPSTDay = new Date(pstYear, pstMonth - 1, pstDay).getDay();

    let daysUntil = dayOfWeek - currentPSTDay;
    if (daysUntil < 0) daysUntil += 7;

    if (daysUntil === 0) {
      const [slotHour, slotMin] = slot.startTime.split(':').map(Number);
      const slotTimeValue = slotHour * 60 + slotMin;
      const currentTimeValue = pstHour * 60 + pstMin;

      if (slotTimeValue <= currentTimeValue) {
        daysUntil = 7;
      }
    }

    // Calculate target PST date
    const targetPST = new Date(pstYear, pstMonth - 1, pstDay + daysUntil);
    const targetYear = targetPST.getFullYear();
    const targetMonth = targetPST.getMonth() + 1;
    const targetDay = targetPST.getDate();

    const [startHour, startMin] = slot.startTime.split(':').map(Number);
    const [endHour, endMin] = slot.endTime.split(':').map(Number);

    // Convert PST wall-clock time to UTC timestamp for storage
    const offsetHours = this.isPDT(targetYear, targetMonth, targetDay) ? 7 : 8;

    const startAt = new Date(Date.UTC(
      targetYear, targetMonth - 1, targetDay,
      startHour + offsetHours, startMin, 0, 0
    ));

    let endAt = new Date(Date.UTC(
      targetYear, targetMonth - 1, targetDay,
      endHour + offsetHours, endMin, 0, 0
    ));

    if (endAt <= startAt) {
      endAt = new Date(endAt.getTime() + 24 * 60 * 60 * 1000);
    }

    return { startAt, endAt };
  }

  private isPDT(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const pstString = date.toLocaleString('en-US', { 
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short',
      hour12: false,
    });
    return pstString.includes('PDT');
  }

  private makeJob(
    em: EntityManager,
    schedule: CampaignSchedule,
    campaignId: string,
    profileId: number,
    region: string,
    executeAt: Date,
    jobType: 'slot_start' | 'slot_end',
    action: 'ENABLE' | 'PAUSE',
  ): ScheduleJob {
    const job = em.create(ScheduleJob, {
      schedule,
      campaignId,
      profileId,
      region,
      executeAt,
      jobType,
      action,
      status: 'pending',
    });
    em.persist(job);
    return job;
  }

  private async enqueue(items: Array<{ job: ScheduleJob; delay: number }>): Promise<void> {
    for (const { job, delay } of items) {
      if (!job.executeAt) continue;
      const safeDelay = Math.max(0, delay);
      await this.schedulerQueue.add('execute', { jobId: job.id }, {
        delay: safeDelay,
        jobId: `schedule-${job.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      });
    }
  }

  private resolveActions(userAction: 'ENABLED' | 'PAUSED') {
    return userAction === 'ENABLED'
      ? { startAction: 'ENABLE' as const, endAction: 'PAUSE' as const }
      : { startAction: 'PAUSE' as const, endAction: 'ENABLE' as const };
  }
}