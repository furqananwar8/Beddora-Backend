import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { AmazonCampaignApiClient } from '../../amazon/client/amazon-api.client';
import { SessionService } from 'src/modules/session/service/session.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Processor('campaign-scheduler', { concurrency: 1 })
export class CampaignSchedulerWorker extends WorkerHost {
  constructor(
    private readonly em: EntityManager,
    private readonly amazonClient: AmazonCampaignApiClient,
    private readonly sessionService: SessionService,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<{ jobId: number }>): Promise<void> {
    const em = this.em.fork();

    const scheduleJob = await em.findOne(
      ScheduleJob,
      { id: job.data.jobId },
      { populate: ['schedule'] },
    );

    if (!scheduleJob || scheduleJob.status !== 'pending') {
      return;
    }

    const schedule = scheduleJob.schedule;
    if (!schedule) {
      throw new Error('Schedule relation not loaded');
    }

    if (schedule.isActive === false) {
      console.log(`Job ${job.data.jobId} skipped: parent schedule isActive=false`);
      scheduleJob.status = 'cancelled';
      await em.flush();
      return;
    }

    try {
      const session = await this.sessionService.get(schedule.sessionId || '');
      if (!session?.access_token) {
        throw new Error('No valid Amazon token');
      }

      if (scheduleJob.action === 'ENABLE') {
        await this.amazonClient.updateCampaign(
          session.access_token,
          scheduleJob.profileId as number,
          scheduleJob.region as 'na' | 'eu' | 'fe',
          scheduleJob.campaignId as string,
          { state: 'ENABLED' },
        );
        console.log(`[WORKER] ENABLED campaign ${scheduleJob.campaignId} at ${new Date().toISOString()}`);
      } else if (scheduleJob.action === 'PAUSE') {
        await this.amazonClient.updateCampaign(
          session.access_token,
          scheduleJob.profileId as number,
          scheduleJob.region as 'na' | 'eu' | 'fe',
          scheduleJob.campaignId as string,
          { state: 'PAUSED' },
        );
        console.log(`[WORKER] PAUSED campaign ${scheduleJob.campaignId} at ${new Date().toISOString()}`);
      }

      scheduleJob.status = 'completed';
      scheduleJob.completedAt = new Date();
      await em.flush();

      // ── RE-QUEUE FOR NEXT WEEK (recurring) ──
      if (schedule.isActive && schedule.dayOfWeek !== undefined) {
        await this.scheduleNextWeek(em, schedule, scheduleJob);
      }

    } catch (err: any) {
      scheduleJob.status = 'failed';
      scheduleJob.errorMessage = err.message;
      await em.flush();
      throw err;
    }
  }

  /**
   * After a job completes, schedule the same slot for next week.
   */
  private async scheduleNextWeek(
    em: EntityManager,
    schedule: CampaignSchedule,
    completedJob: ScheduleJob,
  ): Promise<void> {
    if (!completedJob.executeAt) {
      console.warn(`[WORKER] Cannot re-queue: completedJob ${completedJob.id} has no executeAt`);
      return;
    }

    // Find the time slot that was just executed
    const matchingSlot = (schedule.timeSlots ?? []).find(slot => {
      const slotStartHour = parseInt(slot.startTime.split(':')[0], 10);
      const jobHour = completedJob.executeAt!.getHours();
      return slotStartHour === jobHour;
    });

    if (!matchingSlot) return;

    // Calculate next week's date
    const nextWeekDate = new Date(completedJob.executeAt);
    nextWeekDate.setDate(nextWeekDate.getDate() + 7);

    const [startHour, startMin] = matchingSlot.startTime.split(':').map(Number);
    const [endHour, endMin] = matchingSlot.endTime.split(':').map(Number);

    const startAt = new Date(
      nextWeekDate.getFullYear(),
      nextWeekDate.getMonth(),
      nextWeekDate.getDate(),
      startHour,
      startMin,
      0,
      0,
    );

    let endAt = new Date(
      nextWeekDate.getFullYear(),
      nextWeekDate.getMonth(),
      nextWeekDate.getDate(),
      endHour,
      endMin,
      0,
      0,
    );

    if (endAt <= startAt) {
      endAt.setDate(endAt.getDate() + 1);
    }

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

    const now = Date.now();
    
    // Enqueue both jobs
    await this.schedulerQueue.add('execute', { jobId: startJob.id }, {
      delay: Math.max(0, startAt.getTime() - now),
      jobId: `schedule-${startJob.id}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
    });

    await this.schedulerQueue.add('execute', { jobId: endJob.id }, {
      delay: Math.max(0, endAt.getTime() - now),
      jobId: `schedule-${endJob.id}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60000 },
    });

    console.log(`[WORKER] Re-queued weekly jobs for ${schedule.campaignId} day ${schedule.dayOfWeek} at ${startAt.toISOString()}`);
  }

  private resolveActions(userAction: 'ENABLED' | 'PAUSED' | undefined) {
    const action = userAction ?? 'ENABLED';
    return action === 'ENABLED'
      ? { startAction: 'ENABLE' as const, endAction: 'PAUSE' as const }
      : { startAction: 'PAUSE' as const, endAction: 'ENABLE' as const };
  }
}