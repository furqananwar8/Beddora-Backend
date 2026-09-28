import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { formatInTimeZone } from 'date-fns-tz';

import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { AmazonCampaignApiClient } from '../../amazon/client/amazon-api.client';
import { ProfileTokenService } from 'src/modules/session/service/profile-token.service';
import { EmailService } from 'src/modules/email/service/email.service';
import { ScheduleExpanderService } from '../service/schedule-expander.service';
import { TARGET_TZ } from 'src/common/constants/bullmq.constant';
import { JobAlertService } from 'src/modules/alert/service/alert.service';

@Processor('campaign-scheduler', { concurrency: 1 })
export class CampaignSchedulerWorker extends WorkerHost implements OnApplicationBootstrap {
  private logger = new Logger(CampaignSchedulerWorker.name);
  private readonly TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'expired'];
  private redisAlertSent = false;
  private lastAlertTime: number | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly amazonClient: AmazonCampaignApiClient,
    private readonly profileTokenService: ProfileTokenService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly expander: ScheduleExpanderService,
    private readonly jobAlertService: JobAlertService,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {
    super();
    console.log('[WORKER] ✅ CampaignSchedulerWorker INSTANTIATED');
  }

  async onApplicationBootstrap() {
    this.logger.log('[WORKER] Running initial orphan check on bootstrap...');
    await this.enqueueOrphanedJobs();
  }

  async process(job: Job<{ jobId: number }>): Promise<void> {
    const em = this.em.fork();
    const now = new Date();

    this.logger.log(`[WORKER] ════════════════════════════════════════════════════════`);
    this.logger.log(`[WORKER] Job ${job.id} (data.jobId=${job.data.jobId}) started`);

    const scheduleJob = await em.findOne(
      ScheduleJob,
      { id: job.data.jobId },
      { populate: ['schedule'] },
    );

    if (!scheduleJob) {
      this.logger.log(`[WORKER] ❌ Job ${job.data.jobId} NOT FOUND in DB (may have been deleted)`);
      throw new Error(`ScheduleJob ${job.data.jobId} not found in DB`);
    }

    if (scheduleJob.status === 'failed') {
      this.logger.log(`[WORKER] 🔄 RETRY detected for job ${job.data.jobId}, resetting status to pending`);
      scheduleJob.status = 'pending';
      scheduleJob.errorMessage = null;
      await em.flush();
    } else if (scheduleJob.status === 'processing') {
      // Re-delivered after the process died / the lock was lost mid-run.
      // Used to be skipped silently, which ended the weekly chain. ENABLE/PAUSE
      // are idempotent, so resuming is safe.
      this.logger.warn(`[WORKER] ♻️ Job ${job.data.jobId} was interrupted while 'processing' — resuming`);
      scheduleJob.status = 'pending';
      await em.flush();
    }

    if (scheduleJob.status !== 'pending') {
      this.logger.log(`[WORKER] ⏭️ SKIPPED: status is '${scheduleJob.status}', expected 'pending'`);
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

    // A deferred schedule was removed by the user while its slot was running.
    // Deferral exists so that slot can close properly: its slot_end must still
    // run (e.g. PAUSE), otherwise the campaign is left ENABLED indefinitely.
    // Anything else for it is cancelled, and no next-week job is created.
    if (schedule.isActive === false) {
      if (scheduleJob.jobType !== 'slot_end') {
        this.logger.log(`[WORKER] ⏭️ SKIPPED: parent schedule isActive=false (deferred cancellation)`);
        scheduleJob.status = 'cancelled';
        await em.flush();
        return;
      }
      this.logger.log(`[WORKER] 🏁 Deferred schedule ${schedule.id}: running final ${scheduleJob.action} to close the slot`);
    }

    // Create next week's occurrence BEFORE executing, so the weekly chain
    // survives this run failing. Idempotent across retries (unique
    // schedule/jobType/executeAt). If this throws, the reconciler repairs it.
    if (schedule.isActive !== false && schedule.dayOfWeek !== undefined && schedule.dayOfWeek !== null) {
      try {
        const next = await this.expander.ensureNextWeek(schedule, scheduleJob);
        this.logger.log(`[WORKER] 🔗 Next week job ensured: ${next ? `id=${next.id} at ${next.executeAt?.toISOString()}` : 'n/a (no slot)'}`);
      } catch (err: any) {
        this.logger.error(`[WORKER] ⚠️ Could not ensure next week job for ${scheduleJob.id}: ${err.message} (reconciler will retry)`);
      }
    }

    // After an outage, overdue delayed jobs are delivered all at once. Only
    // today's (PT) work is caught up; a job from an earlier day is stale — its
    // action would put the campaign in the wrong state now — so skip it.
    if (scheduleJob.executeAt && this.isStaleFromEarlierDay(scheduleJob.executeAt, now)) {
      this.logger.warn(
        `[WORKER] ⏭️ Job ${scheduleJob.id} was due ${scheduleJob.executeAt.toISOString()} (an earlier PT day) — marking expired, not executing`,
      );
      scheduleJob.status = 'expired';
      scheduleJob.errorMessage = 'Missed execution window (earlier day); not re-run';
      await em.flush();
      return;
    }

    scheduleJob.status = 'processing';
    await em.flush();

    try {
      // Refreshes on demand (Redis refresh token, Postgres fallback) instead of
      // failing whenever the Redis access token has expired.
      const tokenData = await this.profileTokenService.getValidToken(scheduleJob.profileId as number);
      if (!tokenData?.access_token) {
        this.logger.log(`[WORKER] ❌ ERROR: No valid Amazon token for profile ${scheduleJob.profileId}`);
        throw new Error('No valid Amazon token (no refresh token available — reconnect Amazon)');
      }
      this.logger.log(`[WORKER] ✅ Profile token acquired for profile ${scheduleJob.profileId}`);

      if (scheduleJob.action === 'ENABLE') {
        this.logger.log(`[WORKER] 🚀 Calling Amazon API: ENABLE campaign ${scheduleJob.campaignId}`);
        await this.amazonClient.updateCampaign(
          tokenData.access_token,
          scheduleJob.profileId as number,
          scheduleJob.region as 'na' | 'eu' | 'fe',
          scheduleJob.campaignId as string,
          { state: 'ENABLED' },
        );
        this.logger.log(`[WORKER] ✅ SUCCESS: ENABLED campaign ${scheduleJob.campaignId}`);
      } else if (scheduleJob.action === 'PAUSE') {
        this.logger.log(`[WORKER] 🚀 Calling Amazon API: PAUSE campaign ${scheduleJob.campaignId}`);
        await this.amazonClient.updateCampaign(
          tokenData.access_token,
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

    } catch (err: any) {
      this.logger.log(`[WORKER] ❌ Job ${job.data.jobId} FAILED: ${err.message}`);
      scheduleJob.status = 'failed';
      // error_message is varchar(255); a longer Amazon error used to make this
      // flush throw and leave the row stuck in 'processing'.
      scheduleJob.errorMessage = String(err.message ?? err).slice(0, 255);
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

    // 'failed' is what process() itself writes before rethrowing, so it must
    // NOT short-circuit here — it did, and admins were never emailed.
    if (['completed', 'cancelled', 'expired'].includes(scheduleJob.status as any)) {
      this.logger.log(`[WORKER-EVENT] ⏹️ Job ${job.data.jobId} is '${scheduleJob.status}' (cancelled/finished during retry window). No alert needed.`);
      return;
    }

    this.logger.log(`[WORKER-EVENT] Max retries (${maxRetries}) exhausted. Processing final failure.`);

    await this.notifyAdminOfFailure(scheduleJob, err, currentAttempt);

    scheduleJob.status = 'failed';
    scheduleJob.errorMessage = String(err.message ?? err).slice(0, 255);
    await em.flush();
    this.logger.log(`[WORKER-EVENT] ✅ Job ${job.data.jobId} marked as permanently failed`);
  }

  @Cron('0 */55 * * * *')  // Every 55 minutes
  async enqueueOrphanedJobs(): Promise<void> {
    const em = this.em.fork();
    const now = Date.now();

    // Every pending job due in the next hour (or just missed) must be in
    // BullMQ. Previously only rows with bull_job_id NULL were checked, so a
    // job lost from Redis after it had been enqueued was never recovered.
    // Anything older than the grace window is handled by SchedulerRecoveryService
    // (so a days-old ENABLE is never fired blindly).
    const atRiskOrphans = await em.find(
      ScheduleJob,
      {
        status: 'pending',
        executeAt: { $gte: new Date(now - 15 * 60 * 1000), $lte: new Date(now + 60 * 60 * 1000) },
      },
      { orderBy: { executeAt: 'asc', id: 'asc' }, limit: 500 },
    );

    if (atRiskOrphans.length === 0) {
      this.redisAlertSent = false;
      return;
    }

    this.logger.log(`[OUTBOX] Checking ${atRiskOrphans.length} pending jobs due within 60min are enqueued`);

    let redisDownDetected = false;

    for (const job of atRiskOrphans) {
      try {
        const hadBullId = job.bullJobId;
        await this.expander.ensureEnqueued(em, job);
        if (!hadBullId) this.logger.log(`[OUTBOX] ✅ Ensured job ${job.id} is enqueued`);
      } catch (err: any) {
        this.logger.error(`[OUTBOX] ❌ Redis still down? Failed to enqueue ${job.id}: ${err.message}`);
        redisDownDetected = true;
        break;
      }
    }

    if (redisDownDetected) {
      const shouldSend = !this.lastAlertTime 
        || (now - this.lastAlertTime) > (55 * 60 * 1000);

      if (!shouldSend) {
        const minsAgo = Math.round((now - this.lastAlertTime!) / 60000);
        this.logger.log(`[OUTBOX] ⏭️ Alert sent ${minsAgo}min ago, skipping`);
        return;
      }

      try {
        await this.jobAlertService.sendRedisDownAlert();
        this.lastAlertTime = now;
        this.logger.log(`[OUTBOX] 🚨 Redis down alert sent for ${atRiskOrphans.length} at-risk jobs`);
      } catch (alertErr: any) {
        this.logger.error(`[OUTBOX] ❌ Failed to send Redis down alert: ${alertErr.message}`);
      }
    }
  }

  /** True if `executeAt` is on an earlier PT calendar day than `now` and more than 15 min late. */
  private isStaleFromEarlierDay(executeAt: Date, now: Date): boolean {
    const lateMs = now.getTime() - executeAt.getTime();
    if (lateMs <= 15 * 60 * 1000) return false;
    return formatInTimeZone(executeAt, TARGET_TZ, 'yyyy-MM-dd') < formatInTimeZone(now, TARGET_TZ, 'yyyy-MM-dd');
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
    const campaignName = scheduleJob.campaignName;
    const action = scheduleJob.action;
    const jobType = scheduleJob.jobType;
    const executeAt = scheduleJob.executeAt?.toISOString() ?? 'N/A';
    const scheduleId = scheduleJob.schedule?.id ?? 'N/A' as any;

    try {
      this.emailService.sendFailedJobEmail({
        to: adminEmails,
        subject: `Campaign Scheduler Failure: ${campaignId}`,
        template: 'job-failed',
        context: {
          campaignId,
          campaignName,
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
}