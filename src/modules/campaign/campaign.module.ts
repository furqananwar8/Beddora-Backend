import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AmazonRateLimitGuard } from 'src/guards/amazon-rate-limit.gurad';
import { CampaignSeeder } from 'src/seeder/campaign-seeder.service';
import { AmazonApiService } from '../amazon/amazon-api.service';
import { AmazonCampaignApiClient } from '../amazon/client/amazon-api.client';
import { AmazonApiController } from '../amazon/controller/amazon-api.controller';
import { CampaignController } from './controller/campaign.controller';


@Module({
  imports: [HttpModule],
  controllers: [CampaignController, AmazonApiController],
  providers: [
    AmazonApiService,
    CampaignSeeder,
    AmazonRateLimitGuard,
    AmazonCampaignApiClient,
  ],
  exports: [AmazonCampaignApiClient],
})
export class CampaignModule {}