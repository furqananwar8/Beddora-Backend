import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { ScheduleEventsService } from './schedule-events.service';
import { ScheduleStatus } from 'src/common/enum/campaign.enum';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';


@Processor('campaign-schedule')
export class CampaignScheduleProcessor extends WorkerHost {
  constructor(
    private readonly events: ScheduleEventsService,
    private readonly em: EntityManager,
  ) {
    super();
  }

  async process(
    job: Job<{ campaignScheduleId: number; campaignId: number; action: string }>,
  ): Promise<void> {
    const { campaignScheduleId, campaignId, action } = job.data;

    this.events.publish({
      type: 'SCHEDULE_EXECUTING',
      campaignScheduleId,
      campaignId,
      action,
      timestamp: new Date().toISOString(),
    });

    try {
      // TODO: your Amazon Ads API call
      // await this.amazonAdsService.updateCampaignState(campaignId, action);

      await this.em.nativeUpdate(
        CampaignSchedule,
        { id: campaignScheduleId },
        { status: ScheduleStatus.COMPLETED },
      );

      this.events.publish({
        type: 'SCHEDULE_COMPLETED',
        campaignScheduleId,
        campaignId,
        action,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      await this.em.nativeUpdate(
        CampaignSchedule,
        { id: campaignScheduleId },
        { status: ScheduleStatus.FAILED },
      );

      this.events.publish({
        type: 'SCHEDULE_FAILED',
        campaignScheduleId,
        campaignId,
        action,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
    }
}