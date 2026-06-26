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
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { TARGET_TZ } from 'src/common/constants/bullmq.constant';
import { ScheduleExpanderService } from '../service/schedule-expander.service';
import { Logger } from '@nestjs/common';

@Processor('campaign-scheduler', { concurrency: 1 })
export class CampaignSchedulerWorker extends WorkerHost {
  private logger = new Logger(CampaignSchedulerWorker.name);
  
  constructor(
    private readonly em: EntityManager,
    private readonly amazonClient: AmazonCampaignApiClient,
    private readonly sessionService: SessionService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly expander: ScheduleExpanderService,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {
    super();
    console.log('[WORKER] ✅ CampaignSchedulerWorker INSTANTIATED');
  }

  async process(job: Job<{ jobId: number }>): Promise<void> {
    const em = this.em.fork();
    const now = new Date();

    this.logger.log(`[WORKER] ════════════════════════════════════════════════════════`);
    this.logger.log(`[WORKER] Job ${job.id} (data.jobId=${job.data.jobId}) started`);
    this.logger.log(`[WORKER] Server time (ISO):    ${now.toISOString()}`);
    this.logger.log(`[WORKER] Server time (local):  ${now.toString()}`);
    this.logger.log(`[WORKER] Server TZ offset:     ${now.getTimezoneOffset()} min`);
    this.logger.log(`[WORKER] Current PST time:     ${now.toLocaleString('en-US', { timeZone: TARGET_TZ })}`);

    const scheduleJob = await em.findOne(
      ScheduleJob,
      { id: job.data.jobId },
      { populate: ['schedule'] },
    );

    if (!scheduleJob) {
      this.logger.log(`[WORKER] ❌ Job ${job.data.jobId} NOT FOUND in DB (may have been deleted)`);
      return;
    }

    this.logger.log(`[WORKER] Found scheduleJob:`);
    this.logger.log(`[WORKER]   id=${scheduleJob.id}`);
    this.logger.log(`[WORKER]   status=${scheduleJob.status}`);
    this.logger.log(`[WORKER]   action=${scheduleJob.action}`);
    this.logger.log(`[WORKER]   jobType=${scheduleJob.jobType}`);
    this.logger.log(`[WORKER]   executeAt (ISO)=${scheduleJob.executeAt?.toISOString()}`);

    if (scheduleJob.executeAt) {
      const executeAtTime = scheduleJob.executeAt.getTime();
      const nowTime = now.getTime();
      const diffMs = nowTime - executeAtTime;
      const diffSec = Math.round(diffMs / 1000);
      const diffMin = Math.round(diffMs / 60000);
      this.logger.log(`[WORKER]   executeAt vs now: ${diffSec}s (${diffMin}min) ${diffMs > 0 ? 'LATE' : diffMs < 0 ? 'EARLY' : 'ON TIME'}`);
      this.logger.log(`[WORKER]   executeAt in PST:   ${scheduleJob.executeAt.toLocaleString('en-US', { timeZone: TARGET_TZ })}`);
    }

    // Reset status on retry so the job can actually run again
    if (scheduleJob.status === 'failed') {
      this.logger.log(`[WORKER] 🔄 RETRY detected for job ${job.data.jobId}, resetting status to pending`);
      scheduleJob.status = 'pending';
      scheduleJob.errorMessage = null;
      await em.flush();
    }

    if (scheduleJob.status !== 'pending') {
      this.logger.log(`[WORKER] ⏭️ SKIPPED: status is '${scheduleJob.status}', expected 'pending'`);
      return;
    }

    const schedule = scheduleJob.schedule;
    if (!schedule) {
      this.logger.log(`[WORKER] ❌ ERROR: schedule relation not loaded`);
      throw new Error('Schedule relation not loaded');
    }

    this.logger.log(`[WORKER] Parent schedule:`);
    this.logger.log(`[WORKER]   id=${schedule.id}`);
    this.logger.log(`[WORKER]   dayOfWeek=${schedule.dayOfWeek}`);
    this.logger.log(`[WORKER]   isActive=${schedule.isActive}`);
    this.logger.log(`[WORKER]   action=${schedule.action}`);

    if (schedule.isActive === false) {
      this.logger.log(`[WORKER] ⏭️ SKIPPED: parent schedule isActive=false (deferred cancellation)`);
      scheduleJob.status = 'cancelled';
      await em.flush();
      return;
    }

    // Mark as processing before API call
    scheduleJob.status = 'processing';
    await em.flush();

    try {
      const session = await this.sessionService.get(schedule.sessionId || '');
      if (!session?.access_token) {
        this.logger.log(`[WORKER] ❌ ERROR: No valid Amazon token for session ${schedule.sessionId}`);
        throw new Error('No valid Amazon token');
      }
      this.logger.log(`[WORKER] ✅ Session acquired for ${schedule.sessionId}`);

      if (scheduleJob.action === 'ENABLE') {
        this.logger.log(`[WORKER] 🚀 Calling Amazon API: ENABLE campaign ${scheduleJob.campaignId}`);
        await this.amazonClient.updateCampaign(
          session.access_token,
          scheduleJob.profileId as number,
          scheduleJob.region as 'na' | 'eu' | 'fe',
          scheduleJob.campaignId as string,
          { state: 'ENABLED' },
        );
        this.logger.log(`[WORKER] ✅ SUCCESS: ENABLED campaign ${scheduleJob.campaignId}`);
      } else if (scheduleJob.action === 'PAUSE') {
        this.logger.log(`[WORKER] 🚀 Calling Amazon API: PAUSE campaign ${scheduleJob.campaignId}`);
        await this.amazonClient.updateCampaign(
          session.access_token,
          scheduleJob.profileId as number,
          scheduleJob.region as 'na' | 'eu' | 'fe',
          scheduleJob.campaignId as string,
          { state: 'PAUSED' },
        );
        this.logger.log(`[WORKER] ✅ SUCCESS: PAUSED campaign ${scheduleJob.campaignId}`);
      } else {
        this.logger.log(`[WORKER] ⚠️ WARNING: Unknown action '${scheduleJob.action}'`);
      }

      scheduleJob.status = 'completed';
      scheduleJob.completedAt = new Date();
      await em.flush();
      this.logger.log(`[WORKER] ✅ Job ${job.data.jobId} marked as completed`);

      // If this was a deferred schedule (isActive=false), clean it up after slot_end
      if (!schedule.isActive && scheduleJob.jobType === 'slot_end') {
        this.logger.log(`[WORKER] 🧹 Deferred schedule detected, running cleanup`);
        await this.expander.cleanupDeferredSchedule(schedule.id);
        return;
      }

      if (schedule.isActive && schedule.dayOfWeek !== undefined) {
        this.logger.log(`[WORKER] 🔄 Re-queueing next week job for schedule ${schedule.id}`);
        await this.scheduleNextWeek(em, schedule, scheduleJob);
      } else {
        this.logger.log(`[WORKER] ⏭️ Skipping re-queue: isActive=${schedule.isActive}, dayOfWeek=${schedule.dayOfWeek}`);
      }

    } catch (err: any) {
      this.logger.log(`[WORKER] ❌ Job ${job.data.jobId} FAILED: ${err.message}`);
      scheduleJob.status = 'failed';
      scheduleJob.errorMessage = err.message;
      await em.flush();
      throw err;
    }

    this.logger.log(`[WORKER] ════════════════════════════════════════════════════════`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ jobId: number }>, err: Error): Promise<void> {
    const maxRetries = job.opts.attempts ?? 3;
    const currentAttempt = job.attemptsMade;
    const isFinalFailure = currentAttempt >= maxRetries;

    this.logger.log(`[WORKER-EVENT] Job ${job.id} (data.jobId=${job.data.jobId}) FAILED`);
    this.logger.log(`[WORKER-EVENT] Error: ${err.message}`);
    this.logger.log(`[WORKER-EVENT] Attempt: ${currentAttempt}/${maxRetries}, isFinal=${isFinalFailure}`);

    if (!isFinalFailure) {
      this.logger.log(`[WORKER-EVENT] ⏭️ Not final failure, skipping cleanup (will retry)`);
      return;
    }

    const em = this.em.fork();
    const scheduleJob = await em.findOne(
      ScheduleJob,
      { id: job.data.jobId },
      { populate: ['schedule'] },
    );

    if (!scheduleJob) {
      this.logger.log(`[WORKER-EVENT] ❌ ScheduleJob ${job.data.jobId} not found in DB`);
      return;
    }

    this.logger.log(`[WORKER-EVENT] Max retries (${maxRetries}) exhausted. Processing final failure.`);

    await this.notifyAdminOfFailure(scheduleJob, err, currentAttempt);

    // Don't hard-delete on final failure — keep for audit trail
    scheduleJob.status = 'failed';
    scheduleJob.errorMessage = err.message;
    await em.flush();
    this.logger.log(`[WORKER-EVENT] ✅ Job ${job.data.jobId} marked as permanently failed`);
  }

  private async notifyAdminOfFailure(
    scheduleJob: ScheduleJob,
    err: Error,
    attemptsMade: number,
  ): Promise<void> {
    const adminEmail = this.configService.get<string>('ADMIN_EMAIL');
    if (!adminEmail) {
      this.logger.log(`[WORKER-EVENT] ⚠️ ADMIN_EMAIL not configured, skipping failure notification`);
      return;
    }

    const campaignId = scheduleJob.campaignId;
    const action = scheduleJob.action;
    const jobType = scheduleJob.jobType;
    const executeAt = scheduleJob.executeAt?.toISOString() ?? 'N/A';
    const scheduleId = scheduleJob.schedule?.id ?? 'N/A' as any;

    try {
      await this.emailService.sendFailedJobEmail({
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
      this.logger.log(`[WORKER-EVENT] ✅ Failure email sent to admin: ${adminEmail}`);
    } catch (emailErr: any) {
      this.logger.log(`[WORKER-EVENT] ❌ Failed to send admin email: ${emailErr.message}`);
    }
  }

  private async scheduleNextWeek(
    em: EntityManager,
    schedule: CampaignSchedule,
    completedJob: ScheduleJob,
  ): Promise<void> {
    this.logger.log(`[WORKER] scheduleNextWeek called for completedJob.id=${completedJob.id}`);

    if (!completedJob.executeAt) {
      this.logger.warn(`[WORKER] ⚠️ Cannot re-queue: completedJob ${completedJob.id} has no executeAt`);
      return;
    }

    this.logger.log(`[WORKER] completedJob.executeAt (ISO)=${completedJob.executeAt.toISOString()}`);
    this.logger.log(`[WORKER] completedJob.executeAt (PST)=${completedJob.executeAt.toLocaleString('en-US', { timeZone: TARGET_TZ })}`);
    this.logger.log(`[WORKER] completedJob.jobType=${completedJob.jobType}, action=${completedJob.action}`);

    const timeSlots = schedule.timeSlots ?? [];
    if (timeSlots.length === 0) {
      this.logger.log(`[WORKER] ❌ No timeSlots found on schedule ${schedule.id}`);
      return;
    }

    const slot = timeSlots[0];
    const isStartJob = completedJob.jobType === 'slot_start';
    const targetTimeStr = isStartJob ? slot.startTime : slot.endTime;

    if (!targetTimeStr) {
      this.logger.log(`[WORKER] ❌ Could not determine target time for jobType=${completedJob.jobType}`);
      return;
    }

    const targetAction = completedJob.action;

    this.logger.log(`[WORKER] Rescheduling: ${isStartJob ? 'START' : 'END'} at ${targetTimeStr} with action=${targetAction}`);

    const completedPST = toZonedTime(completedJob.executeAt, TARGET_TZ);

    const nextWeekPST = new Date(completedPST);
    nextWeekPST.setDate(nextWeekPST.getDate() + 7);

    const [targetHour, targetMin] = targetTimeStr.split(':').map(Number);
    nextWeekPST.setHours(targetHour, targetMin, 0, 0);

    this.logger.log(`[WORKER] Next week PST date: ${nextWeekPST.toISOString()}`);

    const executeAt = fromZonedTime(nextWeekPST, TARGET_TZ);

    this.logger.log(`[WORKER] Next week executeAt (UTC)=${executeAt.toISOString()} → PST=${executeAt.toLocaleString('en-US', { timeZone: TARGET_TZ })}`);

    const newJob = em.create(ScheduleJob, {
      schedule,
      campaignId: schedule.campaignId,
      profileId: schedule.profileId,
      region: schedule.region,
      executeAt,
      jobType: completedJob.jobType,
      action: targetAction,
      status: 'pending',
    });
    em.persist(newJob);

    await em.flush();
    this.logger.log(`[WORKER] ✅ Created next week job: newJob.id=${newJob.id}`);

    const now = Date.now();
    const delay = executeAt.getTime() - now;

    this.logger.log(`[WORKER] Enqueueing with delay: ${Math.round(delay / 1000)}s`);

    const bullJobId = `schedule-${newJob.id}`;
    const existingBullJob = await this.schedulerQueue.getJob(bullJobId);
    if (existingBullJob) {
      this.logger.log(`[WORKER] ⚠️ BullMQ job ${bullJobId} already exists, removing first`);
      await this.schedulerQueue.remove(bullJobId);
    }

    await this.schedulerQueue.add('execute', { jobId: newJob.id }, {
      delay: Math.max(0, delay),
      jobId: bullJobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
      removeOnFail: { count: 5 },
      removeOnComplete: { count: 10 },
    });

    this.logger.log(`[WORKER] ✅ Re-queued next week job ${bullJobId}`);
  }
}