import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { AmazonCampaignApiClient } from '../../amazon/client/amazon-api.client';
import { SessionService } from 'src/modules/session/service/session.service';

@Processor('campaign-scheduler', { concurrency: 1 })
export class CampaignSchedulerWorker extends WorkerHost {
  constructor(
    private readonly em: EntityManager,
    private readonly amazonClient: AmazonCampaignApiClient,
    private readonly sessionService: SessionService,
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
        // TODO: Uncomment when ready to hit Amazon API
        // await this.amazonClient.updateCampaign(
        //   session.access_token,
        //   scheduleJob.profileId as number,
        //   scheduleJob.region as 'na' | 'eu' | 'fe',
        //   scheduleJob.campaignId as string,
        //   { state: 'enabled' },
        // );
        console.log(`[WORKER] Would ENABLE campaign ${scheduleJob.campaignId} at ${new Date().toISOString()}`);
      } else if (scheduleJob.action === 'PAUSE') {
        // TODO: Uncomment when ready to hit Amazon API
        // await this.amazonClient.updateCampaign(
        //   session.access_token,
        //   scheduleJob.profileId as number,
        //   scheduleJob.region as 'na' | 'eu' | 'fe',
        //   scheduleJob.campaignId as string,
        //   { state: 'paused' },
        // );
        console.log(`[WORKER] Would PAUSE campaign ${scheduleJob.campaignId} at ${new Date().toISOString()}`);
      }

      scheduleJob.status = 'completed';
      scheduleJob.completedAt = new Date();
      await em.flush();
    } catch (err: any) {
      scheduleJob.status = 'failed';
      scheduleJob.errorMessage = err.message;
      await em.flush();
      throw err;
    }
  }
}