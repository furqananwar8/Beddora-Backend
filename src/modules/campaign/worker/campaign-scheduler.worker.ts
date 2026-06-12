import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { AmazonCampaignApiClient } from '../../amazon/client/amazon-api.client';
import { SessionService } from 'src/modules/session/service/session.service';
import { EmailService } from 'src/modules/email/service/email.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';

@Processor('campaign-scheduler', { concurrency: 1 })
export class CampaignSchedulerWorker extends WorkerHost {
  constructor(
    private readonly em: EntityManager,
    private readonly amazonClient: AmazonCampaignApiClient,
    private readonly sessionService: SessionService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ jobId: number }>): Promise<void> {
    const em = this.em.fork();
    const now = new Date();

    console.log(`[WORKER] ════════════════════════════════════════════════════════`);
    console.log(`[WORKER] Job ${job.id} (data.jobId=${job.data.jobId}) started`);
    console.log(`[WORKER] Server time (ISO):    ${now.toISOString()}`);
    console.log(`[WORKER] Server time (local):  ${now.toString()}`);
    console.log(`[WORKER] Server TZ offset:     ${now.getTimezoneOffset()} min (${now.getTimezoneOffset() === 0 ? 'UTC' : now.getTimezoneOffset() === 420 ? 'PDT' : now.getTimezoneOffset() === 480 ? 'PST' : 'other'})`);
    console.log(`[WORKER] Current PST time:     ${now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);

    const scheduleJob = await em.findOne(
      ScheduleJob,
      { id: job.data.jobId },
      { populate: ['schedule'] },
    );

    if (!scheduleJob) {
      console.log(`[WORKER] ❌ Job ${job.data.jobId} NOT FOUND in DB`);
      return;
    }

    console.log(`[WORKER] Found scheduleJob:`);
    console.log(`[WORKER]   id=${scheduleJob.id}`);
    console.log(`[WORKER]   status=${scheduleJob.status}`);
    console.log(`[WORKER]   action=${scheduleJob.action}`);
    console.log(`[WORKER]   jobType=${scheduleJob.jobType}`);
    console.log(`[WORKER]   executeAt (ISO)=${scheduleJob.executeAt?.toISOString()}`);
    console.log(`[WORKER]   executeAt (raw)=${scheduleJob.executeAt}`);

    if (scheduleJob.executeAt) {
      const executeAtTime = scheduleJob.executeAt.getTime();
      const nowTime = now.getTime();
      const diffMs = nowTime - executeAtTime;
      const diffSec = Math.round(diffMs / 1000);
      const diffMin = Math.round(diffMs / 60000);
      console.log(`[WORKER]   executeAt vs now: ${diffSec}s (${diffMin}min) ${diffMs > 0 ? 'LATE' : diffMs < 0 ? 'EARLY' : 'ON TIME'}`);

      const executeAtPST = scheduleJob.executeAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      console.log(`[WORKER]   executeAt in PST:   ${executeAtPST}`);
    }

    if (scheduleJob.status !== 'pending') {
      console.log(`[WORKER] ⏭️ SKIPPED: status is '${scheduleJob.status}', expected 'pending'`);
      return;
    }

    const schedule = scheduleJob.schedule;
    if (!schedule) {
      console.log(`[WORKER] ❌ ERROR: schedule relation not loaded`);
      throw new Error('Schedule relation not loaded');
    }

    console.log(`[WORKER] Parent schedule:`);
    console.log(`[WORKER]   id=${schedule.id}`);
    console.log(`[WORKER]   dayOfWeek=${schedule.dayOfWeek}`);
    console.log(`[WORKER]   isActive=${schedule.isActive}`);
    console.log(`[WORKER]   action=${schedule.action}`);
    console.log(`[WORKER]   timeSlots=${JSON.stringify(schedule.timeSlots)}`);

    if (schedule.isActive === false) {
      console.log(`[WORKER] ⏭️ SKIPPED: parent schedule isActive=false`);
      scheduleJob.status = 'cancelled';
      await em.flush();
      return;
    }

    try {
      const session = await this.sessionService.get(schedule.sessionId || '');
      if (!session?.access_token) {
        console.log(`[WORKER] ❌ ERROR: No valid Amazon token for session ${schedule.sessionId}`);
        throw new Error('No valid Amazon token');
      }
      console.log(`[WORKER] ✅ Session acquired for ${schedule.sessionId}`);

      if (scheduleJob.action === 'ENABLE') {
        console.log(`[WORKER] 🚀 Calling Amazon API: ENABLE campaign ${scheduleJob.campaignId}`);
        await this.amazonClient.updateCampaign(
          session.access_token,
          scheduleJob.profileId as number,
          scheduleJob.region as 'na' | 'eu' | 'fe',
          scheduleJob.campaignId as string,
          { state: 'ENABLED' },
        );
        console.log(`[WORKER] ✅ SUCCESS: ENABLED campaign ${scheduleJob.campaignId}`);
      } else if (scheduleJob.action === 'PAUSE') {
        console.log(`[WORKER] 🚀 Calling Amazon API: PAUSE campaign ${scheduleJob.campaignId}`);
        await this.amazonClient.updateCampaign(
          session.access_token,
          scheduleJob.profileId as number,
          scheduleJob.region as 'na' | 'eu' | 'fe',
          scheduleJob.campaignId as string,
          { state: 'PAUSED' },
        );
        console.log(`[WORKER] ✅ SUCCESS: PAUSED campaign ${scheduleJob.campaignId}`);
      } else {
        console.log(`[WORKER] ⚠️ WARNING: Unknown action '${scheduleJob.action}'`);
      }

      scheduleJob.status = 'completed';
      scheduleJob.completedAt = new Date();
      await em.flush();
      console.log(`[WORKER] ✅ Job ${job.data.jobId} marked as completed`);

      // ── RE-QUEUE FOR NEXT WEEK (recurring) ──
      if (schedule.isActive && schedule.dayOfWeek !== undefined) {
        console.log(`[WORKER] 🔄 Re-queueing weekly jobs for schedule ${schedule.id}`);
        await this.scheduleNextWeek(em, schedule, scheduleJob);
      } else {
        console.log(`[WORKER] ⏭️ Skipping re-queue: isActive=${schedule.isActive}, dayOfWeek=${schedule.dayOfWeek}`);
      }

    } catch (err: any) {
      console.log(`[WORKER] ❌ Job ${job.data.jobId} FAILED: ${err.message}`);
      scheduleJob.status = 'failed';
      scheduleJob.errorMessage = err.message;
      await em.flush();
      throw err;
    }

    console.log(`[WORKER] ════════════════════════════════════════════════════════`);
  }

  /**
   * Handle failed events from BullMQ — called when job fails after all retries exhausted
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ jobId: number }>, err: Error): Promise<void> {
    const em = this.em.fork();
    const maxRetries = job.opts.attempts ?? 3;
    const currentAttempt = job.attemptsMade;

    console.log(`[WORKER-EVENT] Job ${job.id} (data.jobId=${job.data.jobId}) FAILED permanently`);
    console.log(`[WORKER-EVENT] Error: ${err.message}`);
    console.log(`[WORKER-EVENT] Attempts: ${currentAttempt}/${maxRetries}`);

    const scheduleJob = await em.findOne(
      ScheduleJob,
      { id: job.data.jobId },
      { populate: ['schedule'] },
    );

    if (!scheduleJob) {
      console.log(`[WORKER-EVENT] ❌ ScheduleJob ${job.data.jobId} not found in DB`);
      return;
    }

    // Send email notification to admin
    await this.notifyAdminOfFailure(scheduleJob, err, currentAttempt);

    // If retries exhausted, delete from database
    if (currentAttempt >= maxRetries) {
      console.log(`[WORKER-EVENT] Max retries (${maxRetries}) exhausted. Deleting job ${job.data.jobId} from DB.`);
      await em.remove(scheduleJob).flush();
      console.log(`[WORKER-EVENT] ✅ Job ${job.data.jobId} deleted from DB`);
    } else {
      console.log(`[WORKER-EVENT] Retries not exhausted (${currentAttempt}/${maxRetries}). Keeping job in DB for retry.`);
    }
  }

  /**
   * Send failure notification email to admin
   */
  private async notifyAdminOfFailure(
    scheduleJob: ScheduleJob,
    err: Error,
    attemptsMade: number,
  ): Promise<void> {
    const adminEmail = this.configService.get<string>('ADMIN_EMAIL');
    if (!adminEmail) {
      console.log(`[WORKER-EVENT] ⚠️ ADMIN_EMAIL not configured, skipping failure notification`);
      return;
    }

    const campaignId = scheduleJob.campaignId;
    const action = scheduleJob.action;
    const jobType = scheduleJob.jobType;
    const executeAt = scheduleJob.executeAt?.toISOString() ?? 'N/A';
    const scheduleId = scheduleJob.schedule?.id ?? 'N/A' as any;

    try {
      this.emailService.sendFailedJobEmail({
        to: adminEmail,
        subject: `Campaign Scheduler Failure: ${campaignId}`,
        template: 'job-failed',
        context: {
          campaignId,
          action,
          jobType,
          scheduleId,
          executeAt,
          errorMessage: err.message,
          attemptsMade,
          timestamp: new Date().toISOString(),
        },
      });
      console.log(`[WORKER-EVENT] ✅ Failure email sent to admin: ${adminEmail}`);
    } catch (emailErr: any) {
      console.log(`[WORKER-EVENT] ❌ Failed to send admin email: ${emailErr.message}`);
    }
  }

  /**
   * After a job completes, schedule the same slot for next week.
   * FIXED: Uses all time slots from schedule instead of fragile hour-matching.
   * FIXED: Properly handles DST transitions (PDT/PST).
   */
  private async scheduleNextWeek(
    em: EntityManager,
    schedule: CampaignSchedule,
    completedJob: ScheduleJob,
  ): Promise<void> {
    console.log(`[WORKER] scheduleNextWeek called for completedJob.id=${completedJob.id}`);

    if (!completedJob.executeAt) {
      console.warn(`[WORKER] ⚠️ Cannot re-queue: completedJob ${completedJob.id} has no executeAt`);
      return;
    }

    console.log(`[WORKER] completedJob.executeAt (ISO)=${completedJob.executeAt.toISOString()}`);
    console.log(`[WORKER] completedJob.executeAt (PST)=${completedJob.executeAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);

    // Use ALL time slots from the schedule — no fragile hour-matching
    const timeSlots = schedule.timeSlots ?? [];

    if (timeSlots.length === 0) {
      console.log(`[WORKER] ❌ No timeSlots found on schedule ${schedule.id}`);
      return;
    }

    console.log(`[WORKER] Found ${timeSlots.length} time slot(s) on schedule ${schedule.id}`);

    // For each time slot, create next week's jobs
    for (const slot of timeSlots) {
      console.log(`[WORKER] Processing slot for next week: ${JSON.stringify(slot)}`);

      const [startHour, startMin] = slot.startTime.split(':').map(Number);
      const [endHour, endMin] = slot.endTime.split(':').map(Number);

      // Calculate next week's date in PST
      const nextWeekPST = new Date(completedJob.executeAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      nextWeekPST.setDate(nextWeekPST.getDate() + 7);

      console.log(`[WORKER] Next week PST date: ${nextWeekPST.toISOString()}`);

      // Determine if next week is PDT or PST
      const offsetHours = this.isPDT(nextWeekPST.getFullYear(), nextWeekPST.getMonth() + 1, nextWeekPST.getDate()) ? 7 : 8;
      const offsetStr = offsetHours === 7 ? '-07:00' : '-08:00';
      console.log(`[WORKER] DST check: next week is ${offsetHours === 7 ? 'PDT (UTC-7)' : 'PST (UTC-8)'}`);

      // Build PST time strings with explicit offset and convert to UTC
      const startPSTString = `${nextWeekPST.getFullYear()}-${String(nextWeekPST.getMonth() + 1).padStart(2, '0')}-${String(nextWeekPST.getDate()).padStart(2, '0')}T${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00${offsetStr}`;
      const startAt = new Date(startPSTString);

      let endPSTString = `${nextWeekPST.getFullYear()}-${String(nextWeekPST.getMonth() + 1).padStart(2, '0')}-${String(nextWeekPST.getDate()).padStart(2, '0')}T${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00${offsetStr}`;
      let endAt = new Date(endPSTString);

      // If end time is before start time, it spans midnight → next day in PST
      if (endAt <= startAt) {
        const endNextDayPST = new Date(nextWeekPST);
        endNextDayPST.setDate(endNextDayPST.getDate() + 1);
        endPSTString = `${endNextDayPST.getFullYear()}-${String(endNextDayPST.getMonth() + 1).padStart(2, '0')}-${String(endNextDayPST.getDate()).padStart(2, '0')}T${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00${offsetStr}`;
        endAt = new Date(endPSTString);
        console.log(`[WORKER] End spans midnight, adjusted endAt=${endAt.toISOString()}`);
      }

      console.log(`[WORKER] Next week startAt (UTC)=${startAt.toISOString()} → PST=${startAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);
      console.log(`[WORKER] Next week endAt (UTC)=${endAt.toISOString()} → PST=${endAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);

      const { startAction, endAction } = this.resolveActions(schedule.action ?? 'ENABLED');

      // Create new jobs for next week
      const startJob = em.create(ScheduleJob, {
        schedule,
        campaignId: schedule.campaignId,
        profileId: schedule.profileId,
        region: schedule.region,
        executeAt: startAt,
        jobType: 'slot_start',
        action: startAction,
        status: 'pending',
      });
      em.persist(startJob);

      const endJob = em.create(ScheduleJob, {
        schedule,
        campaignId: schedule.campaignId,
        profileId: schedule.profileId,
        region: schedule.region,
        executeAt: endAt,
        jobType: 'slot_end',
        action: endAction,
        status: 'pending',
      });
      em.persist(endJob);

      await em.flush();
      console.log(`[WORKER] ✅ Created next week jobs: startJob.id=${startJob.id}, endJob.id=${endJob.id}`);

      const now = Date.now();
      const startDelay = startAt.getTime() - now;
      const endDelay = endAt.getTime() - now;

      console.log(`[WORKER] Enqueueing with delays: start=${Math.round(startDelay/1000)}s, end=${Math.round(endDelay/1000)}s`);

      await this.schedulerQueue.add('execute', { jobId: startJob.id }, {
        delay: Math.max(0, startDelay),
        jobId: `schedule-${startJob.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      });

      await this.schedulerQueue.add('execute', { jobId: endJob.id }, {
        delay: Math.max(0, endDelay),
        jobId: `schedule-${endJob.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      });

      console.log(`[WORKER] ✅ Re-queued next week jobs for slot ${slot.startTime}-${slot.endTime}`);
    }
  }

  /**
   * Check if a given date is in PDT (daylight saving) or PST (standard time).
   */
  private isPDT(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const pstString = date.toLocaleString('en-US', { 
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short',
      hour12: false,
    });
    const isPDT = pstString.includes('PDT');
    console.log(`[WORKER]   isPDT(${year}-${month}-${day}): ${pstString} → ${isPDT}`);
    return isPDT;
  }

  private resolveActions(userAction: 'ENABLED' | 'PAUSED' | undefined) {
    const action = userAction ?? 'ENABLED';
    return action === 'ENABLED'
      ? { startAction: 'ENABLE' as const, endAction: 'PAUSE' as const }
      : { startAction: 'PAUSE' as const, endAction: 'ENABLE' as const };
  }
}