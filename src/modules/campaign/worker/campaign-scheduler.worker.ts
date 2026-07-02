import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { AmazonCampaignApiClient } from '../../amazon/client/amazon-api.client';
import { SessionService } from 'src/modules/session/service/session.service';
import { EmailService } from 'src/modules/email/service/email.service';
import { ScheduleExpanderService } from '../service/schedule-expander.service';
import { TARGET_TZ } from 'src/common/constants/bullmq.constant';

@Processor('campaign-scheduler', { concurrency: 1 })
export class CampaignSchedulerWorker extends WorkerHost {
  private logger = new Logger(CampaignSchedulerWorker.name);
  private readonly TERMINAL_STATUSES = ['pending','completed','failed','cancelled','processing','expired'];

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
      this.logger.warn(`[WORKER] 🧟 ZOMBIE JOB ${job.data.jobId}: not found in DB. Removing from queue.`);
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

    if (this.TERMINAL_STATUSES.includes(scheduleJob.status as any)) {
      this.logger.warn(
        `[WORKER] ⏹️ Job ${job.data.jobId} has terminal status '${scheduleJob.status}' ` +
        `(likely cancelled while Redis was down). Skipping execution.`
      );
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

    if (scheduleJob.status === 'failed') {
      const failureAge = Date.now() - (scheduleJob.updatedAt?.getTime() ?? 0);
      const MAX_RETRY_AGE_MS = 24 * 60 * 60 * 1000;

      if (failureAge > MAX_RETRY_AGE_MS) {
        this.logger.warn(`[WORKER] ⏹️ Job ${job.data.jobId} failed ${Math.round(failureAge / 3600000)}h ago, not retrying`);
        scheduleJob.status = 'expired';
        await em.flush();
        return;
      }

      this.logger.log(`[WORKER] 🔄 RETRY detected for job ${job.data.jobId}, resetting status to pending`);
      scheduleJob.status = 'pending';
      scheduleJob.errorMessage = null;
      await em.flush();
    }

    if (scheduleJob.status !== 'pending') {
      this.logger.log(`[WORKER] ⏭️ SKIPPED: status is '${scheduleJob.status}', expected 'pending'`);
      return;
    }

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

    if (this.TERMINAL_STATUSES.includes(scheduleJob.status as any)) {
      this.logger.log(`[WORKER-EVENT] ⏹️ Job ${job.data.jobId} was cancelled/deleted during retry window. No alert needed.`);
      return;
    }

    this.logger.log(`[WORKER-EVENT] Max retries (${maxRetries}) exhausted. Processing final failure.`);

    await this.notifyAdminOfFailure(scheduleJob, err, currentAttempt);

    scheduleJob.status = 'failed';
    scheduleJob.errorMessage = err.message;
    await em.flush();
    this.logger.log(`[WORKER-EVENT] ✅ Job ${job.data.jobId} marked as permanently failed`);
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async enqueueOrphanedJobs(): Promise<void> {
    const em = this.em.fork();
    const now = Date.now();
    const oneWeekFromNow = new Date(now + 7 * 24 * 60 * 60 * 1000);

    const orphaned = await em.find(
      ScheduleJob,
      {
        status: 'pending',
        bullJobId: null,
        executeAt: { $lte: oneWeekFromNow },
      },
      { limit: 50 },
    );

    if (orphaned.length === 0) return;

    this.logger.log(`[OUTBOX] Found ${orphaned.length} orphaned jobs to enqueue`);

    for (const job of orphaned) {
      const delay = (job.executeAt as any).getTime() - now;
      const bullJobId = `schedule-${job.id}`;

      try {
        const existing = await this.schedulerQueue.getJob(bullJobId);
        if (existing) {
          job.bullJobId = bullJobId;
          await em.flush();
          continue;
        }

        await this.schedulerQueue.add('execute', { jobId: job.id }, {
          delay: Math.max(0, delay),
          jobId: bullJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60000 },
          removeOnFail: { count: 5 },
          removeOnComplete: { count: 10 },
        });

        job.bullJobId = bullJobId;
        await em.flush();
        this.logger.log(`[OUTBOX] ✅ Enqueued orphaned job ${job.id}`);

      } catch (err: any) {
        this.logger.error(`[OUTBOX] ❌ Redis still down? Failed to enqueue ${job.id}: ${err.message}`);
        break;
      }
    }
  }

  private async notifyAdminOfFailure(
    scheduleJob: ScheduleJob,
    err: Error,
    attemptsMade: number,
  ): Promise<void> {
    const adminEmailsRaw = this.configService.get<string>('ADMIN_EMAIL');
    if (!adminEmailsRaw) {
      this.logger.log(`[WORKER-EVENT] ⚠️ ADMIN_EMAIL not configured, skipping failure notification`);
      return;
    }

    const adminEmails = adminEmailsRaw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);

    if (adminEmails.length === 0) {
      this.logger.log(`[WORKER-EVENT] ⚠️ No valid admin emails found`);
      return;
    }

    const campaignId = scheduleJob.campaignId;
    const action = scheduleJob.action;
    const jobType = scheduleJob.jobType;
    const executeAt = scheduleJob.executeAt?.toISOString() ?? 'N/A';
    const scheduleId = scheduleJob.schedule?.id ?? 'N/A' as any;

    try {
      (this.emailService as any).sendFailedJobEmail({
        to: adminEmails,
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
      this.logger.log(`[WORKER-EVENT] ✅ Failure email sent to admins: ${adminEmails.join(', ')}`);
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
      bullJobId: null,
    });
    em.persist(newJob);
    await em.flush();

    this.logger.log(`[WORKER] ✅ Created next week DB job: newJob.id=${newJob.id}`);

    const now = Date.now();
    const delay = executeAt.getTime() - now;
    const bullJobId = `schedule-${newJob.id}`;

    this.logger.log(`[WORKER] Enqueueing with delay: ${Math.round(delay / 1000)}s`);

    try {
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

      newJob.bullJobId = bullJobId;
      await em.flush();

      this.logger.log(`[WORKER] ✅ Re-queued next week job ${bullJobId}`);

    } catch (redisErr: any) {
      this.logger.error(
        `[WORKER] ❌ Redis enqueue failed for next-week job ${newJob.id}: ${redisErr.message}. ` +
        `Outbox cron will retry when Redis is back.`
      );
      // Job remains in DB with bullJobId=null; enqueueOrphanedJobs will pick it up
    }
  }
}