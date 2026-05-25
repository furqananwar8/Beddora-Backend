// src/campaign-schedule/campaign-schedule.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CampaignScheduleController } from './controller/campaign-schedule.controller';
import { CampaignScheduleService } from './service/campaign-schedule.service';
import { ScheduleEventsService } from './schedule-events.service';
import { CampaignScheduleProcessor } from './campaign-schedule.processor';
import { RedisModule } from 'src/redis/redis.module';


@Module({
  imports: [
    RedisModule,
    BullModule.registerQueue({
      name: 'campaign-schedule',
    }),
  ],
  controllers: [CampaignScheduleController],
  providers: [
    CampaignScheduleService,
    ScheduleEventsService, 
    CampaignScheduleProcessor
],
})
export class CampaignScheduleModule {}