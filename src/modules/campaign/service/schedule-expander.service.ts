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
    console.log(`[EXPANDER] ════════════════════════════════════════════════════════`);
    console.log(`[EXPANDER] syncSchedules called`);
    console.log(`[EXPANDER] campaignId=${campaignId}, profileId=${profileId}, region=${region}`);
    console.log(`[EXPANDER] incoming configs: ${JSON.stringify(incoming)}`);
    console.log(`[EXPANDER] Server time (ISO): ${new Date().toISOString()}`);
    console.log(`[EXPANDER] Server time (local): ${new Date().toString()}`);
    console.log(`[EXPANDER] Server TZ offset: ${new Date().getTimezoneOffset()} min`);
    console.log(`[EXPANDER] Current PST: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);

    const em = this.em.fork();
    const existing = await this.fetchActive(em, campaignId);
    console.log(`[EXPANDER] Found ${existing.length} existing active schedules`);

    const incomingKeys = this.keySet(incoming);
    console.log(`[EXPANDER] Incoming keys: ${Array.from(incomingKeys).join(', ')}`);

    const { keep, cancel } = this.partition(existing, incomingKeys);
    console.log(`[EXPANDER] Keep: ${keep.length}, Cancel: ${cancel.length}`);

    const cancelled = await this.cancel(em, cancel);
    const create = this.extractNew(incoming, keep);
    console.log(`[EXPANDER] New configs to create: ${create.length}`);

    const created = await this.create(em, campaignId, profileId, region, sessionId, create);

    await em.flush();

    console.log(`[EXPANDER] Result: created=${created}, cancelled=${cancelled}`);
    console.log(`[EXPANDER] ════════════════════════════════════════════════════════`);

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
      console.log(`[EXPANDER] Cancelling schedule ${schedule.id}: ${jobs.length} pending jobs`);
      for (const job of jobs) {
        try {
          await this.schedulerQueue.remove(`schedule-${job.id}`);
          console.log(`[EXPANDER]   Removed queue job schedule-${job.id}`);
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
      console.log(`[EXPANDER] Building schedule for dayOfWeek=${cfg.dayOfWeek}, action=${cfg.action}`);
      console.log(`[EXPANDER]   timeSlots=${JSON.stringify(cfg.timeSlots)}`);

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
      console.log(`[EXPANDER]   Created CampaignSchedule id=${schedule.id}`);

      const { startAction, endAction } = this.resolveActions(cfg.action);

      for (const slot of cfg.timeSlots) {
        console.log(`[EXPANDER]   Processing slot: ${slot.startTime} - ${slot.endTime}`);
        const { startAt, endAt } = this.nextOccurrenceInPST(cfg.dayOfWeek, slot);

        console.log(`[EXPANDER]   startAt (UTC)=${startAt.toISOString()} → PST=${startAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);
        console.log(`[EXPANDER]   endAt (UTC)=${endAt.toISOString()} → PST=${endAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);

        const startJob = this.makeJob(em, schedule, campaignId, profileId, region, startAt, 'slot_start', startAction);
        const endJob = this.makeJob(em, schedule, campaignId, profileId, region, endAt, 'slot_end', endAction);

        const startDelay = startAt.getTime() - Date.now();
        const endDelay = endAt.getTime() - Date.now();

        console.log(`[EXPANDER]   startJob.id=${startJob.id}, delay=${Math.round(startDelay/1000)}s`);
        console.log(`[EXPANDER]   endJob.id=${endJob.id}, delay=${Math.round(endDelay/1000)}s`);

        out.push({ job: startJob, delay: startDelay });
        out.push({ job: endJob, delay: endDelay });
      }
    }

    return out;
  }

  private nextOccurrenceInPST(
    dayOfWeek: number,
    slot: TimeSlot,
  ): { startAt: Date; endAt: Date } {
    const timeZone = 'America/Los_Angeles';
    const now = new Date();

    console.log(`[EXPANDER] nextOccurrenceInPST called: dayOfWeek=${dayOfWeek}, slot=${JSON.stringify(slot)}`);

    // Get current PST date components (works regardless of server timezone)
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

    console.log(`[EXPANDER]   Current PST: ${pstYear}-${String(pstMonth).padStart(2,'0')}-${String(pstDay).padStart(2,'0')} ${String(pstHour).padStart(2,'0')}:${String(pstMin).padStart(2,'0')}`);

    // Get PST day of week
    const currentPSTDay = new Date(pstYear, pstMonth - 1, pstDay).getDay();
    console.log(`[EXPANDER]   currentPSTDay=${currentPSTDay} (0=Sun, 1=Mon, ...), targetDay=${dayOfWeek}`);

    let daysUntil = dayOfWeek - currentPSTDay;
    if (daysUntil < 0) daysUntil += 7;
    console.log(`[EXPANDER]   daysUntil initial=${daysUntil}`);

    if (daysUntil === 0) {
      const [slotHour, slotMin] = slot.startTime.split(':').map(Number);
      const slotTimeValue = slotHour * 60 + slotMin;
      const currentTimeValue = pstHour * 60 + pstMin;

      console.log(`[EXPANDER]   Same day check: slotTime=${slotHour}:${slotMin} (${slotTimeValue}), currentTime=${pstHour}:${pstMin} (${currentTimeValue})`);

      if (slotTimeValue <= currentTimeValue) {
        daysUntil = 7;
        console.log(`[EXPANDER]   Slot already passed today, pushing to next week: daysUntil=7`);
      } else {
        console.log(`[EXPANDER]   Slot still today: daysUntil=0`);
      }
    }

    // Calculate target PST date
    const targetPST = new Date(pstYear, pstMonth - 1, pstDay + daysUntil);
    const targetYear = targetPST.getFullYear();
    const targetMonth = targetPST.getMonth() + 1;
    const targetDay = targetPST.getDate();

    console.log(`[EXPANDER]   Target PST date: ${targetYear}-${String(targetMonth).padStart(2,'0')}-${String(targetDay).padStart(2,'0')}`);

    const [startHour, startMin] = slot.startTime.split(':').map(Number);
    const [endHour, endMin] = slot.endTime.split(':').map(Number);

    console.log(`[EXPANDER]   Slot times: start=${startHour}:${startMin}, end=${endHour}:${endMin} (PST wall-clock)`);

    // Determine if target date is in PDT or PST
    const offsetHours = this.isPDT(targetYear, targetMonth, targetDay) ? 7 : 8;
    console.log(`[EXPANDER]   DST check: target is ${offsetHours === 7 ? 'PDT (UTC-7)' : 'PST (UTC-8)'}`);

    // Convert PST wall-clock time to UTC timestamp for storage
    const startAt = new Date(Date.UTC(
      targetYear, targetMonth - 1, targetDay,
      startHour + offsetHours, startMin, 0, 0
    ));

    let endAt = new Date(Date.UTC(
      targetYear, targetMonth - 1, targetDay,
      endHour + offsetHours, endMin, 0, 0
    ));

    console.log(`[EXPANDER]   Before midnight check: startAt=${startAt.toISOString()}, endAt=${endAt.toISOString()}`);

    if (endAt <= startAt) {
      endAt = new Date(endAt.getTime() + 24 * 60 * 60 * 1000);
      console.log(`[EXPANDER]   End spans midnight, adjusted endAt=${endAt.toISOString()}`);
    }

    console.log(`[EXPANDER]   FINAL: startAt=${startAt.toISOString()} (PST: ${startAt.toLocaleString('en-US', { timeZone })})`);
    console.log(`[EXPANDER]   FINAL: endAt=${endAt.toISOString()} (PST: ${endAt.toLocaleString('en-US', { timeZone })})`);

    return { startAt, endAt };
  }

  private isPDT(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const pstString = date.toLocaleString('en-US', { 
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short',
      hour12: false,
    });
    const isPDT = pstString.includes('PDT');
    console.log(`[EXPANDER]   isPDT(${year}-${month}-${day}): ${pstString} → ${isPDT}`);
    return isPDT;
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
    console.log(`[EXPANDER] Enqueueing ${items.length} jobs to BullMQ`);
    for (const { job, delay } of items) {
      if (!job.executeAt) continue;
      const safeDelay = Math.max(0, delay);
      console.log(`[EXPANDER]   Adding job ${job.id} (${job.jobType}, ${job.action}) with delay=${Math.round(safeDelay/1000)}s, executeAt=${job.executeAt.toISOString()}`);
      await this.schedulerQueue.add('execute', { jobId: job.id }, {
        delay: safeDelay,
        jobId: `schedule-${job.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      });
      console.log(`[EXPANDER]   ✅ Enqueued schedule-${job.id}`);
    }
  }

  private resolveActions(userAction: 'ENABLED' | 'PAUSED') {
    return userAction === 'ENABLED'
      ? { startAction: 'ENABLE' as const, endAction: 'PAUSE' as const }
      : { startAction: 'PAUSE' as const, endAction: 'ENABLE' as const };
  }
}