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
  scheduleDate: string;
  endDate?: string;
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

    const incomingKeys = this.keySet(incoming);
    const { keep, cancel } = this.partition(existing, incomingKeys);

    const cancelled = await this.cancel(em, cancel);
    const create = this.extractNew(incoming, keep);
    console.log({cancelled})
    console.log({create})
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
        keys.add(`${cfg.scheduleDate}|${slot.startTime}|${slot.endTime}`);
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
        incomingKeys.has(`${schedule.scheduleDate}|${slot.startTime}|${slot.endTime}`),
      );
      (matches ? keep : cancel).push(schedule);
    }

    return { keep, cancel };
  }

  private extractNew(incoming: ScheduleConfig[], keep: CampaignSchedule[]): ScheduleConfig[] {
    const keepKeys = new Set(
      keep.flatMap(s => (s.timeSlots ?? []).map(slot => `${s.scheduleDate}|${slot.startTime}|${slot.endTime}`)),
    );

    const out: ScheduleConfig[] = [];
    for (const cfg of incoming) {
      for (const slot of cfg.timeSlots) {
        const key = `${cfg.scheduleDate}|${slot.startTime}|${slot.endTime}`;
        if (!keepKeys.has(key)) {
          out.push({ ...cfg, timeSlots: [slot] });
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
        scheduleDate: cfg.scheduleDate,
        endDate: cfg.endDate,
        timeSlots: cfg.timeSlots,
        action: cfg.action,
        isActive: true,
      });
      em.persist(schedule);

      const dates = this.dateRange(cfg.scheduleDate, cfg.endDate);
      const { startAction, endAction } = this.resolveActions(cfg.action);

      for (const date of dates) {
        for (const slot of cfg.timeSlots) {
          const { startAt, endAt } = this.executionWindow(date, slot);

          out.push(
            { job: this.makeJob(em, schedule, campaignId, profileId, region, startAt, 'slot_start', startAction), delay: startAt.getTime() - Date.now() },
            { job: this.makeJob(em, schedule, campaignId, profileId, region, endAt, 'slot_end', endAction), delay: endAt.getTime() - Date.now() },
          );
        }
      }
    }

    return out;
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
      if (!job.executeAt || delay <= 0) continue;
      await this.schedulerQueue.add('execute', { jobId: job.id }, { delay, jobId: `schedule-${job.id}` });
    }
  }

  private dateRange(startYmd: string, endYmd?: string): Date[] {
    const start = this.parseYmd(startYmd);
    const end = endYmd ? this.parseYmd(endYmd) : new Date(start);
    const dates: Date[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(new Date(d));
    }
    return dates;
  }

  private executionWindow(date: Date, slot: TimeSlot): { startAt: Date; endAt: Date } {
    const startAt = this.toUtc(date, slot.startTime);
    const endAt = this.toUtc(date, slot.endTime);
    if (endAt <= startAt) endAt.setDate(endAt.getDate() + 1);
    return { startAt, endAt };
  }

  private toUtc(date: Date, time: string): Date {
    const [h, min] = time.split(':').map(Number);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, min));
  }

  private parseYmd(str: string): Date {
    return new Date(Date.UTC(
      parseInt(str.slice(0, 4), 10),
      parseInt(str.slice(4, 6), 10) - 1,
      parseInt(str.slice(6, 8), 10),
    ));
  }

  private resolveActions(userAction: 'ENABLED' | 'PAUSED') {
    return userAction === 'ENABLED'
      ? { startAction: 'ENABLE' as const, endAction: 'PAUSE' as const }
      : { startAction: 'PAUSE' as const, endAction: 'ENABLE' as const };
  }
}