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
import { EmailModule } from '../email/email.module';
import { RedisModule } from 'src/redis/redis.module';
import { RedisLifecycleService } from 'src/redis/redis-lifecycle.service';
import { RedisReconciliationService } from 'src/redis/redis-reconciliation.service';
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [
    HttpModule,
    SessionModule,
    EmailModule,
    AlertModule,
    BullModule.registerQueue({ name: 'campaign-scheduler' }),
    RedisModule,
  ],
  controllers: [CampaignController, AmazonApiController],
  providers: [
    AmazonApiService,
    AmazonRateLimitGuard,
    AmazonCampaignApiClient,
    ScheduleExpanderService,
    CampaignSchedulerWorker,
    RedisLifecycleService,
    RedisReconciliationService,
  ],
  exports: [AmazonCampaignApiClient],
})
export class CampaignModule {}