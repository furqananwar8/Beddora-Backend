import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { toZonedTime, fromZonedTime, format } from 'date-fns-tz';
import { TARGET_TZ } from 'src/common/constants/bullmq.constant';

interface TimeSlot {
  startTime: string;
  endTime: string;
}

interface ScheduleConfig {
  dayOfWeek: number;
  timeSlots: TimeSlot[];
  action: 'ENABLED' | 'PAUSED';
  campaignName?: string;
}

interface SyncResult {
  schedulesCreated: number;
  schedulesRemoved: number;
  jobsCreated: number;
  jobsCancelled: number;
}

@Injectable()
export class ScheduleExpanderService {
  private readonly logger = new Logger(ScheduleExpanderService.name);

  constructor(
    private readonly em: EntityManager,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {}

  async clearAllSchedules(
    campaignId: string,
  ): Promise<{ schedulesRemoved: number; jobsCancelled: number }> {
    const em = this.em.fork();
    
    const allSchedules = await em.find(CampaignSchedule, { campaignId }, {
      populate: ['jobs'],
    });

    if (allSchedules.length === 0) {
      this.logger.log(`[CLEAR] No schedules found for campaign ${campaignId}`);
      return { schedulesRemoved: 0, jobsCancelled: 0 };
    }

    let jobsCancelled = 0;

    for (const schedule of allSchedules) {
      for (const job of schedule.jobs) {
        if (job.status === 'pending') {
          try {
            await this.schedulerQueue.remove(`schedule-${job.id}`);
            this.logger.log(`[CLEAR] Removed BullMQ job schedule-${job.id}`);
          } catch (err: any) {
            this.logger.error(`[CLEAR] Failed to remove BullMQ job schedule-${job.id}: ${err.message}`);
          }
          jobsCancelled++;
        }
        em.remove(job);
      }
      em.remove(schedule);
    }

    await em.flush();

    this.logger.log(`[CLEAR] Hard-deleted ${allSchedules.length} schedules and their jobs for campaign ${campaignId}`);

    return {
      schedulesRemoved: allSchedules.length,
      jobsCancelled,
    };
  }

  async syncSchedules(
    campaignId: string,
    profileId: number,
    region: string,
    sessionId: string,
    incoming: ScheduleConfig[],
    campaignName?: string,
  ): Promise<SyncResult> {
    this.logger.log(`[EXPANDER] ════════════════════════════════════════════════════════`);
    this.logger.log(`[EXPANDER] syncSchedules called`);
    this.logger.log(`[EXPANDER] campaignId=${campaignId}, profileId=${profileId}, region=${region}`);
    this.logger.log(`[EXPANDER] incoming configs: ${JSON.stringify(incoming)}`);
    this.logger.log(`[EXPANDER] Server time (ISO): ${new Date().toISOString()}`);
    this.logger.log(`[EXPANDER] Server time (local): ${new Date().toString()}`);
    this.logger.log(`[EXPANDER] Server TZ offset: ${new Date().getTimezoneOffset()} min`);
    this.logger.log(`[EXPANDER] Current PST: ${new Date().toLocaleString('en-US', { timeZone: TARGET_TZ })}`);

    const em = this.em.fork();
    const existing = await this.fetchActive(em, campaignId);
    this.logger.log(`[EXPANDER] Found ${existing.length} existing active schedules`);

    const incomingKeys = this.keySet(incoming);
    this.logger.log(`[EXPANDER] Incoming keys: ${Array.from(incomingKeys).join(', ')}`);

    const { keep, cancel, defer } = await this.partitionWithSafetyCheck(em, existing, incomingKeys);
    this.logger.log(`[EXPANDER] Keep: ${keep.length}, Cancel: ${cancel.length}, Defer: ${defer.length}`);

    // Mark deferred schedules for deletion after slot_end
    for (const schedule of defer) {
      schedule.isActive = false; // prevent next-week re-queueing
      schedule.updatedAt = new Date();
      this.logger.log(`[EXPANDER] Deferred cancellation for schedule ${schedule.id} (today's active slot)`);
    }

    const cancelled = await this.cancel(em, cancel);
    const create = this.extractNew(incoming, keep);
    this.logger.log(`[EXPANDER] New configs to create: ${create.length}`);

    const created = await this.create(em, campaignId, profileId, region, sessionId, create, campaignName);

    await em.flush();

    this.logger.log(`[EXPANDER] Result: created=${created}, cancelled=${cancelled}, deferred=${defer.length}`);
    this.logger.log(`[EXPANDER] ════════════════════════════════════════════════════════`);

    return {
      schedulesCreated: create.length,
      schedulesRemoved: cancel.length,
      jobsCreated: created,
      jobsCancelled: cancelled,
    };
  }

  /**
   * Deferred cleanup: called by worker after slot_end completes
   */
  async cleanupDeferredSchedule(scheduleId: number): Promise<void> {
    const em = this.em.fork();
    const schedule = await em.findOne(CampaignSchedule, { id: scheduleId }, {
      populate: ['jobs'],
    });

    if (!schedule) {
      this.logger.log(`[CLEANUP] Schedule ${scheduleId} already deleted`);
      return;
    }

    // Only cleanup if it was deferred (isActive=false and has no pending jobs)
    if (schedule.isActive) {
      this.logger.log(`[CLEANUP] Schedule ${scheduleId} is still active, skipping cleanup`);
      return;
    }

    const pendingJobs = schedule.jobs.filter(j => j.status === 'pending');
    if (pendingJobs.length > 0) {
      this.logger.log(`[CLEANUP] Schedule ${scheduleId} has ${pendingJobs.length} pending jobs, skipping cleanup`);
      return;
    }

    this.logger.log(`[CLEANUP] Hard-deleting deferred schedule ${scheduleId}`);

    for (const job of schedule.jobs) {
      em.remove(job);
    }
    em.remove(schedule);

    await em.flush();
    this.logger.log(`[CLEANUP] ✅ Schedule ${scheduleId} and all jobs deleted`);
  }

  async findOrphanedJobs(campaignId?: string): Promise<Array<{ jobId: number; campaignId: string; executeAt: Date }>> {
    const em = this.em.fork();
    const where = campaignId ? { status: 'pending', campaignId } : { status: 'pending' } as any;
    const pendingJobs = await em.find(ScheduleJob, where);

    const orphaned: Array<{ jobId: number; campaignId: string; executeAt: Date }> = [];

    for (const job of pendingJobs) {
      const bullJob = await this.schedulerQueue.getJob(`schedule-${job.id}`);
      if (!bullJob) {
        orphaned.push({
          jobId: job.id,
          campaignId: job.campaignId as any,
          executeAt: job.executeAt!,
        });
        this.logger.log(`[DIAG] Orphaned job found: DB id=${job.id}, no BullMQ job exists`);
      }
    }

    return orphaned;
  }

  async repairOrphanedJobs(campaignId?: string): Promise<number> {
    const orphaned = await this.findOrphanedJobs(campaignId);
    let repaired = 0;

    for (const orphan of orphaned) {
      const em = this.em.fork();
      const job = await em.findOne(ScheduleJob, { id: orphan.jobId });

      if (!job?.executeAt) continue;

      const delay = job.executeAt.getTime() - Date.now();
      if (delay < -3600000) {
        this.logger.log(`[REPAIR] Job ${job.id} is too far in the past, marking as failed`);
        job.status = 'failed';
        job.errorMessage = 'Orphaned job - missed execution window';
        await em.flush();
        continue;
      }

      const bullJobId = `schedule-${job.id}`;
      await this.schedulerQueue.add('execute', { jobId: job.id }, {
        delay: Math.max(0, delay),
        jobId: bullJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      });

      this.logger.log(`[REPAIR] Re-enqueued job ${job.id} with delay=${Math.round(delay / 1000)}s`);
      repaired++;
    }

    return repaired;
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

  /**
   * Partition schedules into keep, cancel, and defer (for today's active slots)
   */
  private async partitionWithSafetyCheck(
    em: EntityManager,
    existing: CampaignSchedule[],
    incomingKeys: Set<string>,
  ): Promise<{ keep: CampaignSchedule[]; cancel: CampaignSchedule[]; defer: CampaignSchedule[] }> {
    const keep: CampaignSchedule[] = [];
    const cancel: CampaignSchedule[] = [];
    const defer: CampaignSchedule[] = [];
    const now = Date.now();
    const safetyWindowMs = 5 * 60 * 1000; // 5 minutes

    for (const schedule of existing) {
      const slot = schedule.timeSlots?.[0];
      if (!slot) {
        cancel.push(schedule);
        continue;
      }

      const key = `${schedule.dayOfWeek}|${slot.startTime}|${slot.endTime}`;
      if (incomingKeys.has(key)) {
        keep.push(schedule);
        continue;
      }

      // Check if any job for this schedule is currently in progress or about to run
      const jobs = await em.find(ScheduleJob, { schedule });
      const hasActiveJob = jobs.some(job => {
        if (!job.executeAt) return false;
        const executeTime = job.executeAt.getTime();
        
        // Job is currently being processed
        if (job.status === 'processing') return true;
        
        // Job is about to start within safety window
        const isAboutToStart = executeTime > now && executeTime < now + safetyWindowMs;
        
        // Job should have run but hasn't completed (slot is in progress)
        const isInWindow = executeTime < now && job.status === 'pending';
        
        return isAboutToStart || isInWindow;
      });

      if (hasActiveJob) {
        this.logger.log(`[EXPANDER] SAFETY: Schedule ${schedule.id} has active/upcoming jobs, deferring cancellation`);
        defer.push(schedule);
      } else {
        cancel.push(schedule);
      }
    }

    return { keep, cancel, defer };
  }

  private extractNew(incoming: ScheduleConfig[], keep: CampaignSchedule[]): ScheduleConfig[] {
    const keepKeys = new Set<string>();
    for (const schedule of keep) {
      const slot = schedule.timeSlots?.[0];
      if (slot) {
        keepKeys.add(`${schedule.dayOfWeek}|${slot.startTime}|${slot.endTime}`);
      }
    }

    const out: ScheduleConfig[] = [];
    for (const cfg of incoming) {
      for (const slot of cfg.timeSlots) {
        const key = `${cfg.dayOfWeek}|${slot.startTime}|${slot.endTime}`;
        if (!keepKeys.has(key)) {
          out.push({
            dayOfWeek: cfg.dayOfWeek,
            timeSlots: [slot],
            action: cfg.action,
          });
        }
      }
    }
    return out;
  }

  private async cancel(em: EntityManager, schedules: CampaignSchedule[]): Promise<number> {
    let count = 0;
    for (const schedule of schedules) {
      const jobs = await em.find(ScheduleJob, { schedule });
      this.logger.log(`[EXPANDER] Cancelling schedule ${schedule.id}: ${jobs.length} total jobs`);

      for (const job of jobs) {
        if (job.status === 'pending' || job.status === 'cancelled') {
          try {
            await this.schedulerQueue.remove(`schedule-${job.id}`);
            this.logger.log(`[EXPANDER]   Removed queue job schedule-${job.id}`);
          } catch {
            /* noop */
          }
        }
        em.remove(job);
        count++;
      }

      em.remove(schedule);
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
    campaignName?: string,
  ): Promise<number> {
    if (configs.length === 0) return 0;

    const jobs = this.buildJobs(em, campaignId, profileId, region, sessionId, configs, campaignName);
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
    campaignName?: string
  ): Array<{ job: ScheduleJob; delay: number }> {
    const out: Array<{ job: ScheduleJob; delay: number }> = [];

    for (const cfg of configs) {
      this.logger.log(`[EXPANDER] Building schedule for dayOfWeek=${cfg.dayOfWeek}, action=${cfg.action}`);
      const { startAction, endAction } = this.resolveActions(cfg.action);

      for (const slot of cfg.timeSlots) {
        this.logger.log(`[EXPANDER]   Processing slot: ${slot.startTime} - ${slot.endTime}`);

        const schedule = em.create(CampaignSchedule, {
          campaignId,
          profileId,
          region,
          sessionId,
          dayOfWeek: cfg.dayOfWeek,
          timeSlots: [slot],
          action: cfg.action,
          isActive: true,
          campaignName: campaignName || cfg.campaignName
        });
        em.persist(schedule);
        this.logger.log(`[EXPANDER]   Created CampaignSchedule id=${schedule.id} with slot [${slot.startTime}-${slot.endTime}]`);

        const { startAt, endAt } = this.nextOccurrenceInTargetTz(cfg.dayOfWeek, slot);

        this.logger.log(`[EXPANDER]   startAt (UTC)=${startAt.toISOString()} → PST=${startAt.toLocaleString('en-US', { timeZone: TARGET_TZ })}`);
        this.logger.log(`[EXPANDER]   endAt (UTC)=${endAt.toISOString()} → PST=${endAt.toLocaleString('en-US', { timeZone: TARGET_TZ })}`);

        const startJob = this.makeJob(em, schedule, campaignId, profileId, region, startAt, 'slot_start', startAction, campaignName);
        const endJob = this.makeJob(em, schedule, campaignId, profileId, region, endAt, 'slot_end', endAction, campaignName);

        const startDelay = startAt.getTime() - Date.now();
        const endDelay = endAt.getTime() - Date.now();

        this.logger.log(`[EXPANDER]   startJob.id=${startJob.id}, delay=${Math.round(startDelay / 1000)}s`);
        this.logger.log(`[EXPANDER]   endJob.id=${endJob.id}, delay=${Math.round(endDelay / 1000)}s`);

        out.push({ job: startJob, delay: startDelay });
        out.push({ job: endJob, delay: endDelay });
      }
    }

    return out;
  }


  private nextOccurrenceInTargetTz(
    dayOfWeek: number,
    slot: TimeSlot,
  ): { startAt: Date; endAt: Date } {
    const startAt = this.nextOccurrence(dayOfWeek, slot.startTime, slot.endTime);
    const [endHour, endMin] = slot.endTime.split(':').map(Number);

    // Build endAt from the SAME day as startAt
    const startPST = toZonedTime(startAt, TARGET_TZ);
    const endPST = new Date(
      startPST.getFullYear(),
      startPST.getMonth(),
      startPST.getDate(),
      endHour,
      endMin,
      0,
      0,
    );
    let endAt = fromZonedTime(endPST, TARGET_TZ);

    // Handle overnight slots (e.g., 22:00 - 02:00)
    if (endAt <= startAt) {
      endAt = new Date(endAt.getTime() + 24 * 60 * 60 * 1000);
    }

    return { startAt, endAt };
  }

    private nextOccurrence(
    dayOfWeek: number,
    startTimeStr: string,
    endTimeStr: string,
    baseDate: Date = new Date()
  ): Date {
    const [hours, minutes] = startTimeStr.split(':').map(Number);
    const [endHours, endMinutes] = endTimeStr.split(':').map(Number);

    // Work entirely in wall-clock LA time
    const zonedNow = toZonedTime(baseDate, TARGET_TZ);

    const candidateZoned = new Date(
      zonedNow.getFullYear(),
      zonedNow.getMonth(),
      zonedNow.getDate(),
      hours,
      minutes,
      0,
      0
    );

    const endZoned = new Date(
      zonedNow.getFullYear(),
      zonedNow.getMonth(),
      zonedNow.getDate(),
      endHours,
      endMinutes,
      0,
      0
    );

    // If slot crosses midnight (e.g., 22:00-02:00), endZoned is on the next calendar day
    if (endHours < hours || (endHours === hours && endMinutes < minutes)) {
      endZoned.setDate(endZoned.getDate() + 1);
    }

    this.logger.log(
      `[EXPANDER]   nextOccurrence: zonedNow=${format(zonedNow, 'yyyy-MM-dd HH:mm:ssxxx', { timeZone: TARGET_TZ })}`
    );

    let daysUntil = dayOfWeek - candidateZoned.getDay();
    if (daysUntil < 0) daysUntil += 7;

    const candidateUtc = fromZonedTime(candidateZoned, TARGET_TZ);
    const endUtc = fromZonedTime(endZoned, TARGET_TZ);

    // Same day and start time has already passed (or is right now)
    if (daysUntil === 0 && candidateUtc.getTime() <= baseDate.getTime()) {
      // Strictly-less-than: at the exact end instant, treat as closed
      if (baseDate.getTime() < endUtc.getTime()) {
        this.logger.log(
          `[EXPANDER]   Within active slot (${startTimeStr}-${endTimeStr}), keeping today`
        );
        // daysUntil stays 0 — candidateZoned remains at the actual slot start time
      } else {
        // Past the end of the slot (or exactly at it) — push to next week
        daysUntil = 7;
        this.logger.log(
          `[EXPANDER]   Slot ended at ${endTimeStr}, pushing to next week`
        );
      }
    }

    candidateZoned.setDate(candidateZoned.getDate() + daysUntil);
    const utcResult = fromZonedTime(candidateZoned, TARGET_TZ);

    this.logger.log(`[EXPANDER]   Converted to UTC: ${utcResult.toISOString()}`);

    return utcResult;
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
    campaignName?: string
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
      campaignName
    });
    em.persist(job);
    return job;
  }

  private async enqueue(items: Array<{ job: ScheduleJob; delay: number }>): Promise<void> {
    this.logger.log(`[EXPANDER] Enqueueing ${items.length} jobs to BullMQ`);
    for (const { job, delay } of items) {
      if (!job.executeAt) continue;

      const bullJobId = `schedule-${job.id}`;
      const safeDelay = Math.max(0, delay);

      const existingJob = await this.schedulerQueue.getJob(bullJobId);
      if (existingJob) {
        this.logger.log(`[EXPANDER]   ⚠️ Job ${bullJobId} already exists (state=${await existingJob.getState()}), removing first`);
        try {
          await this.schedulerQueue.remove(bullJobId);
          this.logger.log(`[EXPANDER]   ✅ Removed existing job ${bullJobId}`);
        } catch (err) {
          this.logger.log(`[EXPANDER]   ❌ Failed to remove existing job ${bullJobId}: ${err}`);
        }
      }

      this.logger.log(`[EXPANDER]   Adding job ${job.id} (${job.jobType}, ${job.action}) with delay=${Math.round(safeDelay / 1000)}s, executeAt=${job.executeAt.toISOString()}`);

      await this.schedulerQueue.add(
        'execute',
        { jobId: job.id },
        {
          delay: safeDelay,
          jobId: bullJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60000 },
          removeOnFail: { count: 5 },
          removeOnComplete: { count: 10 },
        },
      );

      this.logger.log(`[EXPANDER]   ✅ Enqueued ${bullJobId}`);
    }
  }

  private resolveActions(userAction: 'ENABLED' | 'PAUSED') {
    return userAction === 'ENABLED'
      ? { startAction: 'ENABLE' as const, endAction: 'PAUSE' as const }
      : { startAction: 'PAUSE' as const, endAction: 'ENABLE' as const };
  }
}