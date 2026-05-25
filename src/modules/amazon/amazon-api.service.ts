import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { AmazonCampaign } from 'src/entities/amazon-campaign.entity';


export interface AmazonSPCampaignResponse {
  campaigns: Array<{
    campaignId: number;
    name: string;
    campaignType: string;
    targetingType: string;
    state: string;
    dailyBudget: number;
    startDate: string;
    endDate?: string;
    premiumBidAdjustment: boolean;
    bidding?: any;
    tags?: Record<string, string>;
  }>;
  nextToken?: string;
}

@Injectable()
export class AmazonApiService {
  constructor(private readonly em: EntityManager) {}

  async getCampaigns(
    nextToken?: string,
    count: number = 100,
    profileId?: number,
  ): Promise<any> {
    const pageSize = Math.min(Math.max(count, 1), 100);
    const offset = nextToken ? this.decodeToken(nextToken) : 0;
    const where = profileId ? { profileId } : {};

    const [campaigns, total] = await this.em.findAndCount(AmazonCampaign, where, {
      limit: pageSize,
      offset,
      orderBy: { campaignId: 'ASC' },
    });

    const nextOffset = offset + campaigns.length;
    const hasMore = nextOffset < total;

    return {
      campaigns: campaigns.map((c) => ({
        campaignId: c.campaignId,
        name: c.name,
        campaignType: c.campaignType,
        targetingType: c.targetingType,
        state: c.state,
        dailyBudget: c.dailyBudget,
        startDate: c.startDate,
        endDate: c.endDate,
        premiumBidAdjustment: c.premiumBidAdjustment,
        bidding: c.bidding,
        tags: c.tags,
      })),
      nextToken: hasMore ? this.encodeToken(nextOffset) : undefined,
    };
  }

  private encodeToken(offset: number): string {
    return Buffer.from(String(offset)).toString('base64url');
  }

  private decodeToken(token: string): number {
    return parseInt(Buffer.from(token, 'base64url').toString(), 10) || 0;
  }
}