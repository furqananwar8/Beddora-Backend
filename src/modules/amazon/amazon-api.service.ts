import { Injectable } from '@nestjs/common';
import { AmazonCampaignApiClient, AmazonSPCampaignResponse } from './client/amazon-api.client';

@Injectable()
export class AmazonApiService {
  constructor(private readonly amazonClient: AmazonCampaignApiClient) {}

  getProfiles(accessToken: string, region: 'na' | 'eu' | 'fe' = 'na') {
    return this.amazonClient.getProfiles(accessToken, region);
  }
}