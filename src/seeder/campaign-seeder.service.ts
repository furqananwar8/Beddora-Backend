import { Injectable, OnModuleInit } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { ScheduleAction, ScheduleStatus } from 'src/common/enum/campaign.enum';
import { AmazonCampaign } from 'src/entities/amazon-campaign.entity';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { Campaign } from 'src/entities/campaigns.entity';

function formatDateYYYYMMDD(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

@Injectable()
export class CampaignSeeder implements OnModuleInit {
  constructor(private readonly em: EntityManager) {}

  async onModuleInit(): Promise<void> {
    const em = this.em.fork();

    const campaignCount = await em.count(Campaign);
    if (campaignCount > 0) {
      console.log(`[CampaignSeeder] ${campaignCount} campaigns already exist. Skipping seed.`);
      return;
    }

    const today = new Date();
    const amazonCampaigns: AmazonCampaign[] = [];
    const campaigns: Campaign[] = [];
    const schedules: CampaignSchedule[] = [];

    const states = ['enabled', 'paused', 'archived'] as const;
    const strategies = ['legacyForSales', 'autoForSales', 'manual'] as const;
    const targetingTypes = ['manual', 'auto'] as const;
    const actions = [ScheduleAction.ENABLE, ScheduleAction.PAUSE, ScheduleAction.ADJUST_BID];
    const timePool = [
      { startTime: '10:00', endTime: '12:00' },
      { startTime: '16:00', endTime: '20:00' },
      { startTime: '09:00', endTime: '11:00' },
      { startTime: '14:00', endTime: '15:00' },
      { startTime: '23:00', endTime: '00:00' },
      { startTime: '06:00', endTime: '08:00' },
      { startTime: '12:00', endTime: '13:00' },
      { startTime: '19:00', endTime: '21:00' },
    ];

    for (let i = 1; i <= 250; i++) {
      const campaignId = 100000000 + i;
      const startDate = addDays(today, i % 4);
      const endDate = i % 3 === 0 ? formatDateYYYYMMDD(addDays(startDate, 1 + (i % 7))) : undefined;

      // 1. Seed AmazonCampaign (mock API source)
      const amazonCampaign = new AmazonCampaign();
      amazonCampaign.campaignId = campaignId;
      amazonCampaign.name = `SP Campaign ${i} — ${targetingTypes[i % 2]}`;
      amazonCampaign.campaignType = 'sponsoredProducts';
      amazonCampaign.targetingType = targetingTypes[i % 2];
      amazonCampaign.state = states[i % 3];
      amazonCampaign.dailyBudget = parseFloat((Math.random() * 95 + 5).toFixed(2));
      amazonCampaign.startDate = formatDateYYYYMMDD(startDate);
      amazonCampaign.endDate = endDate;
      amazonCampaign.premiumBidAdjustment = i % 4 === 0;
      amazonCampaign.bidding = {
        strategy: strategies[i % 3],
        adjustments: i % 2 === 0 ? [{ predicate: 'placementTop', percentage: 20 + (i % 10) }] : [],
      };
      amazonCampaign.profileId = 123456789;
      amazonCampaigns.push(amazonCampaign);

      // 2. Seed Campaign (internal synced table — what the listing API reads)
      const campaign = new Campaign();
      campaign.campaignId = campaignId;
      campaign.name = amazonCampaign.name;
      campaign.campaignType = amazonCampaign.campaignType;
      campaign.targetingType = amazonCampaign.targetingType;
      campaign.state = amazonCampaign.state;
      campaign.dailyBudget = amazonCampaign.dailyBudget;
      campaign.startDate = amazonCampaign.startDate;
      campaign.endDate = amazonCampaign.endDate;
      campaign.premiumBidAdjustment = amazonCampaign.premiumBidAdjustment;
      campaign.bidding = amazonCampaign.bidding;
      campaign.profileId = amazonCampaign.profileId;
      campaign.lastSyncedAt = new Date();
      campaigns.push(campaign);

      // 3. Seed schedules (0–3 per campaign)
      const scheduleCount = i % 4;
      for (let s = 0; s < scheduleCount; s++) {
        const schedule = new CampaignSchedule();
        schedule.campaignId = campaignId;

        const scheduleDate = addDays(today, (i + s) % 14);
        schedule.scheduleDate = formatDateYYYYMMDD(scheduleDate);

        if ((i + s) % 3 === 0) {
          schedule.endDate = formatDateYYYYMMDD(addDays(scheduleDate, (i % 3) + 1));
        }

        const slotCount = 1 + ((i + s) % 2);
        const shuffled = [...timePool].sort(() => Math.random() - 0.5);
        schedule.timeSlots = shuffled.slice(0, slotCount);

        schedule.timezone = 'UTC';
        schedule.action = actions[(i + s) % actions.length];

        if (schedule.action === ScheduleAction.ADJUST_BID) {
          schedule.bidAdjustment = parseFloat((10 + (i % 50)).toFixed(2));
        }

        schedule.status = ScheduleStatus.QUEUED;
        schedule.createdAt = new Date();
        schedule.updatedAt = new Date();
        schedules.push(schedule);
      }
    }

    for (const c of amazonCampaigns) em.persist(c);
    for (const c of campaigns) em.persist(c);
    for (const s of schedules) em.persist(s);
    await em.flush();

    console.log(`[CampaignSeeder] Seeded ${amazonCampaigns.length} amazon campaigns, ${campaigns.length} synced campaigns, and ${schedules.length} schedules.`);
  }
}