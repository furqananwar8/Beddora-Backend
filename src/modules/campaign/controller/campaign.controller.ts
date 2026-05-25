import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EntityManager } from '@mikro-orm/core';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { Campaign } from 'src/entities/campaigns.entity';
import { SessionAuthGuard } from 'src/guards/SessionAuth.guard';


@ApiTags('Campaigns')
@Controller('campaigns')
export class CampaignController {
  constructor(private readonly em: EntityManager) {}

  @Get()
  // @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({
    summary: 'List campaigns with schedules',
    description: 'Returns 10 campaigns per page with their day-parting schedules embedded.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (1-based)' })
  @ApiQuery({ name: 'state', required: false, description: 'Filter by state: enabled | paused | archived' })
  @ApiResponse({ status: 200, description: 'Paginated campaigns with embedded schedules' })
  async listCampaigns(
    @Query('page') page: string = '1',
    @Query('state') state?: string,
  ): Promise<{ data: any[]; meta: { total: number; page: number; limit: number; totalPages: number } }> {
    const em = this.em.fork();
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limit = 10;
    const offset = (pageNum - 1) * limit;

    const where: any = {};
    if (state) where.state = state;

    const [campaigns, total] = await em.findAndCount(Campaign, where, {
      limit,
      offset,
      orderBy: { lastSyncedAt: 'DESC' },
    });

    const campaignIds = campaigns.map((c) => c.campaignId);
    const schedules = campaignIds.length > 0
      ? await em.find(CampaignSchedule, { campaignId: { $in: campaignIds } })
      : [];

    // Explicitly map fields instead of spreading the entity (avoids Loaded<> type leak)
    const data = campaigns.map((campaign) => ({
      campaignId: campaign.campaignId,
      name: campaign.name,
      campaignType: campaign.campaignType,
      targetingType: campaign.targetingType,
      state: campaign.state,
      dailyBudget: campaign.dailyBudget,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      premiumBidAdjustment: campaign.premiumBidAdjustment,
      bidding: campaign.bidding,
      profileId: campaign.profileId,
      lastSyncedAt: campaign.lastSyncedAt,
      schedules: schedules.filter((s) => s.campaignId === campaign.campaignId),
    }));

    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}