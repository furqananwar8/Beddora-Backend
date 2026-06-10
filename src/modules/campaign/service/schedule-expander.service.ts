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
  dayOfWeek: number; // 0-6
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

  async syncSchedules(
    campaignId: string,
    profileId: number,
    region: string,
    sessionId: string,
    incoming: ScheduleConfig[],
  ): Promise<SyncResult> {
    const em = this.em.fork();
    const existing = await this.fetchActive(em, campaignId);

    // Partition: keep matching day+slots, cancel the rest
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
    const TEST_MODE = process.env.SCHEDULER_TEST_MODE === 'true';

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
        // Calculate next occurrence of this dayOfWeek in PST
        const { startAt, endAt } = this.nextOccurrenceInPST(cfg.dayOfWeek, slot);

        out.push(
          { job: this.makeJob(em, schedule, campaignId, profileId, region, startAt, 'slot_start', startAction), delay: startAt.getTime() - Date.now() },
          { job: this.makeJob(em, schedule, campaignId, profileId, region, endAt, 'slot_end', endAction), delay: endAt.getTime() - Date.now() },
        );
      }
    }

    return out;
  }

  /**
   * Calculate the next occurrence of a given dayOfWeek in PST/PDT.
   * If today is that day and the slot hasn't started yet, use today.
   * Otherwise use next week.
   */
  private nextOccurrenceInPST(
    dayOfWeek: number,
    slot: TimeSlot,
  ): { startAt: Date; endAt: Date } {
    const now = new Date();
    
    // Get current PST date components
    const pstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const currentPSTDay = pstNow.getDay(); // 0=Sun, 1=Mon, ...
    
    // Calculate days until target day
    let daysUntil = dayOfWeek - currentPSTDay;
    if (daysUntil < 0) daysUntil += 7;
    
    // If same day, check if slot already passed
    if (daysUntil === 0) {
      const [slotHour, slotMin] = slot.startTime.split(':').map(Number);
      const currentHour = pstNow.getHours();
      const currentMin = pstNow.getMinutes();
      
      const slotTimeValue = slotHour * 60 + slotMin;
      const currentTimeValue = currentHour * 60 + currentMin;
      
      if (slotTimeValue <= currentTimeValue) {
        // Slot already passed today, use next week
        daysUntil = 7;
      }
    }

    // Build the target date in PST
    const targetPST = new Date(pstNow);
    targetPST.setDate(targetPST.getDate() + daysUntil);
    
    const [startHour, startMin] = slot.startTime.split(':').map(Number);
    const [endHour, endMin] = slot.endTime.split(':').map(Number);
    
    // Create PST-local Date objects (browser/Node will interpret as local, but we treat as PST)
    const startAt = new Date(
      targetPST.getFullYear(),
      targetPST.getMonth(),
      targetPST.getDate(),
      startHour,
      startMin,
      0,
      0,
    );
    
    let endAt = new Date(
      targetPST.getFullYear(),
      targetPST.getMonth(),
      targetPST.getDate(),
      endHour,
      endMin,
      0,
      0,
    );

    // If end time is before start time, it spans midnight → next day
    if (endAt <= startAt) {
      endAt.setDate(endAt.getDate() + 1);
    }

    return { startAt, endAt };
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
        backoff: {
          type: 'exponential',
          delay: 60000,
        },
      });
    }
  }

  private resolveActions(userAction: 'ENABLED' | 'PAUSED') {
    return userAction === 'ENABLED'
      ? { startAction: 'ENABLE' as const, endAction: 'PAUSE' as const }
      : { startAction: 'PAUSE' as const, endAction: 'ENABLE' as const };
  }
}