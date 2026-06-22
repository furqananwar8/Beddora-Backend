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
    console.log('[WORKER] ✅ CampaignSchedulerWorker INSTANTIATED');
  }

  async process(job: Job<{ jobId: number }>): Promise<void> {
    const em = this.em.fork();
    const now = new Date();

    console.log(`[WORKER] ════════════════════════════════════════════════════════`);
    console.log(`[WORKER] Job ${job.id} (data.jobId=${job.data.jobId}) started`);
    console.log(`[WORKER] Server time (ISO):    ${now.toISOString()}`);
    console.log(`[WORKER] Server time (local):  ${now.toString()}`);
    console.log(`[WORKER] Server TZ offset:     ${now.getTimezoneOffset()} min`);
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

    if (scheduleJob.executeAt) {
      const executeAtTime = scheduleJob.executeAt.getTime();
      const nowTime = now.getTime();
      const diffMs = nowTime - executeAtTime;
      const diffSec = Math.round(diffMs / 1000);
      const diffMin = Math.round(diffMs / 60000);
      console.log(`[WORKER]   executeAt vs now: ${diffSec}s (${diffMin}min) ${diffMs > 0 ? 'LATE' : diffMs < 0 ? 'EARLY' : 'ON TIME'}`);
      console.log(`[WORKER]   executeAt in PST:   ${scheduleJob.executeAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);
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

      if (schedule.isActive && schedule.dayOfWeek !== undefined) {
        console.log(`[WORKER] 🔄 Re-queueing next week job for schedule ${schedule.id}`);
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

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ jobId: number }>, err: Error): Promise<void> {
    const maxRetries = job.opts.attempts ?? 3;
    const currentAttempt = job.attemptsMade;
    const isFinalFailure = currentAttempt >= maxRetries;

    console.log(`[WORKER-EVENT] Job ${job.id} (data.jobId=${job.data.jobId}) FAILED`);
    console.log(`[WORKER-EVENT] Error: ${err.message}`);
    console.log(`[WORKER-EVENT] Attempt: ${currentAttempt}/${maxRetries}, isFinal=${isFinalFailure}`);

    if (!isFinalFailure) {
      console.log(`[WORKER-EVENT] ⏭️ Not final failure, skipping cleanup (will retry)`);
      return;
    }

    const em = this.em.fork();
    const scheduleJob = await em.findOne(
      ScheduleJob,
      { id: job.data.jobId },
      { populate: ['schedule'] },
    );

    if (!scheduleJob) {
      console.log(`[WORKER-EVENT] ❌ ScheduleJob ${job.data.jobId} not found in DB`);
      return;
    }

    console.log(`[WORKER-EVENT] Max retries (${maxRetries}) exhausted. Processing final failure.`);

    await this.notifyAdminOfFailure(scheduleJob, err, currentAttempt);

    console.log(`[WORKER-EVENT] Deleting job ${job.data.jobId} from DB.`);
    await em.remove(scheduleJob).flush();
    console.log(`[WORKER-EVENT] ✅ Job ${job.data.jobId} deleted from DB`);
  }

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
      console.log(`[WORKER-EVENT] ✅ Failure email sent to admin: ${adminEmail}`);
    } catch (emailErr: any) {
      console.log(`[WORKER-EVENT] ❌ Failed to send admin email: ${emailErr.message}`);
    }
  }

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
    console.log(`[WORKER] completedJob.jobType=${completedJob.jobType}, action=${completedJob.action}`);

    const timeSlots = schedule.timeSlots ?? [];
    if (timeSlots.length === 0) {
      console.log(`[WORKER] ❌ No timeSlots found on schedule ${schedule.id}`);
      return;
    }

    const slot = timeSlots[0];
    const isStartJob = completedJob.jobType === 'slot_start';
    const targetTimeStr = isStartJob ? slot.startTime : slot.endTime;

    if (!targetTimeStr) {
      console.log(`[WORKER] ❌ Could not determine target time for jobType=${completedJob.jobType}`);
      return;
    }

    const [targetHour, targetMin] = targetTimeStr.split(':').map(Number);
    const targetAction = completedJob.action;

    console.log(`[WORKER] Rescheduling: ${isStartJob ? 'START' : 'END'} at ${targetTimeStr} with action=${targetAction}`);

    const nextWeekPST = new Date(completedJob.executeAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    nextWeekPST.setDate(nextWeekPST.getDate() + 7);

    console.log(`[WORKER] Next week PST date: ${nextWeekPST.toISOString()}`);

    const nextYear = nextWeekPST.getFullYear();
    const nextMonth = nextWeekPST.getMonth() + 1;
    const nextDay = nextWeekPST.getDate();
    const offsetHours = this.isPDT(nextYear, nextMonth, nextDay) ? 7 : 8;
    const offsetStr = offsetHours === 7 ? '-07:00' : '-08:00';
    console.log(`[WORKER] DST check: next week is ${offsetHours === 7 ? 'PDT (UTC-7)' : 'PST (UTC-8)'}`);

    const targetPSTString = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}T${String(targetHour).padStart(2, '0')}:${String(targetMin).padStart(2, '0')}:00${offsetStr}`;
    const executeAt = new Date(targetPSTString);

    console.log(`[WORKER] Next week executeAt (UTC)=${executeAt.toISOString()} → PST=${executeAt.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);

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
    console.log(`[WORKER] ✅ Created next week job: newJob.id=${newJob.id}`);

    const now = Date.now();
    const delay = executeAt.getTime() - now;

    console.log(`[WORKER] Enqueueing with delay: ${Math.round(delay / 1000)}s`);

    const bullJobId = `schedule-${newJob.id}`;
    const existingBullJob = await this.schedulerQueue.getJob(bullJobId);
    if (existingBullJob) {
      console.log(`[WORKER] ⚠️ BullMQ job ${bullJobId} already exists, removing first`);
      await this.schedulerQueue.remove(bullJobId);
    }

    await this.schedulerQueue.add('execute', { jobId: newJob.id }, {
      delay: Math.max(0, delay),
      jobId: bullJobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
    });

    console.log(`[WORKER] ✅ Re-queued next week job ${bullJobId}`);
  }

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
}