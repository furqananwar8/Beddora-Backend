import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { ScheduleStatus } from 'src/common/enum/campaign.enum';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { CreateScheduleDto } from '../dto/campaign-schedule.dto';


@Injectable()
export class CampaignScheduleService {
  constructor(private readonly em: EntityManager) {}

  /**
   * Sync schedules for a campaign.
   * - Dates no longer sent → DELETED from DB
   * - Dates already sent but slots changed → UPDATED
   * - New dates → INSERTED
   */
  async syncSchedules(campaignId: number, dtos: CreateScheduleDto[]): Promise<void> {
    const em = this.em.fork();

    // 1. Load existing schedules for this campaign
    const existing = await em.find(CampaignSchedule, { campaignId });
    const incomingDates = new Set(dtos.map((d) => d.scheduleDate));

    // 2. Delete dates the user removed (deselected old ones)
    const toDelete = existing.filter((e) => !incomingDates.has(e.scheduleDate));
    if (toDelete.length > 0) {
      await em.nativeDelete(CampaignSchedule, {
        id: { $in: toDelete.map((s) => s.id) },
      });
    }

    // 3. Upsert: update existing dates, insert new ones
    for (const dto of dtos) {
      const match = existing.find((e) => e.scheduleDate === dto.scheduleDate);

      if (match) {
        // Update slots / action / times if user changed them
        match.timeSlots = dto.timeSlots;
        match.action = dto.action;
        match.timezone = dto.timezone;
        match.bidAdjustment = dto.bidAdjustment;
        match.endDate = dto.endDate;
        match.status = ScheduleStatus.QUEUED; // reset if it was completed
      } else {
        // Brand new date
        const schedule = new CampaignSchedule();
        schedule.campaignId = campaignId;
        schedule.scheduleDate = dto.scheduleDate;
        schedule.endDate = dto.endDate;
        schedule.timeSlots = dto.timeSlots;
        schedule.timezone = dto.timezone;
        schedule.action = dto.action;
        schedule.bidAdjustment = dto.bidAdjustment;
        schedule.status = ScheduleStatus.QUEUED;
        em.persist(schedule);
      }
    }

    await em.flush();
  }

  async getSchedules(campaignId: number): Promise<CampaignSchedule[]> {
    return this.em.fork().find(CampaignSchedule, { campaignId });
  }
}