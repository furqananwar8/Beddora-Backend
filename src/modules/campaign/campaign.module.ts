import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { AmazonRateLimitGuard } from 'src/guards/amazon-rate-limit.gurad';
import { AmazonCampaignApiClient } from '../amazon/client/amazon-api.client';
import { AmazonApiService } from '../amazon/amazon-api.service';
import { AmazonApiController } from '../amazon/controller/amazon-api.controller';
import { CampaignController } from './controller/campaign.controller';
import { ScheduleExpanderService } from './service/schedule-expander.service';
import { CampaignSchedulerWorker } from './worker/campaign-scheduler.worker';
import { SessionModule } from 'src/modules/session/session.module';

@Module({
  imports: [
    HttpModule,
    SessionModule,
    BullModule.registerQueue({ name: 'campaign-scheduler' }),
  ],
  controllers: [CampaignController, AmazonApiController],
  providers: [
    AmazonApiService,
    AmazonRateLimitGuard,
    AmazonCampaignApiClient,
    ScheduleExpanderService,
    CampaignSchedulerWorker,
  ],
  exports: [AmazonCampaignApiClient],
})
export class CampaignModule {}