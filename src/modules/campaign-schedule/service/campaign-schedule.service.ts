// src/campaign-schedule/campaign-schedule.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { DateTime } from 'luxon';
import { ScheduleAction, ScheduleStatus } from 'src/common/enum/campaign.enum';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { BulkScheduleDto } from '../dto/campaign-schedule.dto';
import { Campaign } from 'src/entities/campaigns.entity';

@Injectable()
export class CampaignScheduleService {
  constructor(
    private readonly em: EntityManager,
    @InjectQueue('campaign-schedule') private readonly scheduleQueue: Queue,
  ) {}

  /**
   * Schedule a single campaign (POST /:campaignId/schedule)
   */
  async bulkSchedule(campaignId: number, dto: BulkScheduleDto) {
    const em = this.em.fork();
    const results: { message: string; schedule: CampaignSchedule }[] = [];
    const jobsToUpsert: CampaignSchedule[] = [];
    const jobsToRemove: number[] = [];

    // 1. Get all existing schedules for this campaign
    const existingSchedules = await em.find(CampaignSchedule, { campaignId });
    const incomingDates = new Set(dto.schedules.map((s) => this.normalizeDate(s.scheduleDate)));

    // 2. Delete schedules for dates that are no longer in the payload
    const toDelete = existingSchedules.filter((e) => !incomingDates.has(e.scheduleDate));
    for (const del of toDelete) {
      jobsToRemove.push(del.id);
      em.remove(del);
    }

    // 3. Process each schedule in the payload
    for (const item of dto.schedules) {
      const scheduleDate = this.normalizeDate(item.scheduleDate);
      const endDate = item.endDate ? this.normalizeDate(item.endDate) : undefined;

      // Find existing schedule for this exact date
      const existing = existingSchedules.find((e) => e.scheduleDate === scheduleDate);

      let schedule: CampaignSchedule;
      let isNew = false;

      if (!existing) {
        this.validateFuture(scheduleDate, item.timeSlots, item.timezone, campaignId);
        schedule = em.create(CampaignSchedule, {
          campaignId,
          scheduleDate,
          endDate: endDate ?? null,
          timeSlots: item.timeSlots,
          timezone: item.timezone,
          action: item.action,
          status: ScheduleStatus.SCHEDULED,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        isNew = true;
      } else {
        const changed =
          existing.endDate !== (endDate ?? null) ||
          existing.timezone !== item.timezone ||
          existing.action !== item.action ||
          JSON.stringify(existing.timeSlots) !== JSON.stringify(item.timeSlots);

        if (!changed) {
          results.push({ message: 'No changes detected', schedule: existing });
          continue;
        }

        this.validateFuture(scheduleDate, item.timeSlots, item.timezone, campaignId);
        existing.scheduleDate = scheduleDate;
        if (endDate) existing.endDate = endDate;
        existing.timeSlots = item.timeSlots;
        existing.timezone = item.timezone;
        existing.action = item.action;
        existing.status = ScheduleStatus.SCHEDULED;
        existing.updatedAt = new Date();
        schedule = existing;
      }

      em.persist(schedule);
      jobsToUpsert.push(schedule);

      results.push({
        message: isNew ? 'Campaign scheduled' : 'Schedule updated',
        schedule,
      });
    }

    // 4. Flush all changes (deletes + inserts/updates)
    await em.flush();

    // 5. Remove BullMQ jobs for deleted schedules
    for (const id of jobsToRemove) {
      await this.removeJob(id);
    }

    // 6. Upsert BullMQ jobs for created/updated schedules
    for (const schedule of jobsToUpsert) {
      await this.removeJob(schedule.id); // remove old job if any
      await this.upsertJob(schedule);
    }

    return {
      campaignId,
      deleted: toDelete.length,
      processed: results.length,
      results,
    };
  }

  /**
   * Unschedule a single campaign (DELETE /:campaignId)
   */
  async unschedule(campaignId: number) {
    const todayStr = DateTime.now().toISODate();

    const existing = await this.em.findOne(CampaignSchedule, {
      campaignId,
      scheduleDate: { $gte: todayStr },
      status: { $in: [ScheduleStatus.PENDING, ScheduleStatus.SCHEDULED] },
    });

    if (!existing) {
      return { message: 'No future schedule found for this campaign', campaignId };
    }

    await this.removeJob(existing.id);
    this.em.remove(existing);
    await this.em.flush();

    return { message: 'Schedule removed', campaignId };
  }

    // src/campaign-schedule/campaign-schedule.service.ts

    async createFakeCampaigns(count: number = 3): Promise<any[]> {
        const campaigns: any[] = [];

        for (let i = 0; i < count; i++) {
            const fakeId = Math.floor(100_000_000 + Math.random() * 900_000_000);
            const todayStr = DateTime.now().toISODate()!; // yyyy-MM-dd

            const campaign = this.em.create(Campaign, {
            campaignId: fakeId,
            name: `Fake Sync ${fakeId}`,
            campaignType: 'sponsoredProducts',
            targetingType: 'manual',
            state: 'ENABLED',
            dailyBudget: 10.00,
            startDate: todayStr,
            endDate: null,
            premiumBidAdjustment: false,
            bidding: null,
            profileId: 0,
            lastSyncedAt: new Date(),
            });

            campaigns.push(campaign);
        }

        await this.em.flush();
        return campaigns;
    }

    /**
     * Keep your existing signature — creates a schedule row + BullMQ job.
     */
    async createFakeSchedule(
    campaignId: number,
    delaySeconds: number,
    action: ScheduleAction,
    ): Promise<CampaignSchedule> {
    const future = DateTime.now().plus({ seconds: delaySeconds });

    const schedule = this.em.create(CampaignSchedule, {
        campaignId,
        scheduleDate: future.toISODate()!,
        endDate: null,
        timeSlots: [
        {
            startTime: future.toFormat('HH:mm'),
            endTime: future.plus({ minutes: 1 }).toFormat('HH:mm'),
        },
        ],
        timezone: 'UTC',
        action,
        status: ScheduleStatus.SCHEDULED,
        createdAt: new Date(),
        updatedAt: new Date(),
    });

    await this.em.flush();
    await this.upsertJob(schedule);
    await this.em.flush();

    return schedule;
    }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private normalizeDate(raw: string): string {
    if (/^\d{8}$/.test(raw)) {
      return DateTime.fromFormat(raw, 'yyyyMMdd').toISODate()!;
    }
    return raw;
  }

  private validateFuture(
    date: string,
    timeSlots: Array<{ startTime: string }>,
    timezone: string,
    campaignId: number,
  ) {
    const delay = this.getDelayMs(date, timeSlots, timezone);
    if (delay <= 0) {
      const timeStr = timeSlots[0]?.startTime ?? '';
      throw new BadRequestException(
        `Campaign ${campaignId} schedule must be in the future (${date} ${timeStr})`,
      );
    }
  }

  private getDelayMs(
    date: string,
    timeSlots: Array<{ startTime: string }>,
    timezone: string,
  ): number {
    if (!timeSlots?.length) return -1;
    const scheduled = DateTime.fromISO(`${date}T${timeSlots[0].startTime}`, {
      zone: timezone,
    });
    const now = DateTime.now().setZone(timezone);
    return Math.max(scheduled.diff(now).milliseconds, 0);
  }

  // src/campaign-schedule/campaign-schedule.service.ts

    private getJobId(scheduleId: number): string {
    return `campaign-schedule-${scheduleId}`; // ← dash instead of colon
    }

  private async removeJob(scheduleId: number) {
    const jobId = this.getJobId(scheduleId);
    try {
      const job = await this.scheduleQueue.getJob(jobId);
      if (job) await job.remove();
    } catch (e) {
      console.error(`Failed to remove job ${jobId}`, e);
    }
  }

  private async upsertJob(schedule: CampaignSchedule) {
    const jobId = this.getJobId(schedule.id);
    const delay = this.getDelayMs(
      schedule.scheduleDate,
      schedule.timeSlots,
      schedule.timezone,
    );

    try {
      await this.scheduleQueue.add(
        'execute-schedule',
        {
          campaignScheduleId: schedule.id,
          campaignId: schedule.campaignId,
          action: schedule.action,
        },
        {
          jobId,
          delay,
          removeOnComplete: true,
          removeOnFail: 10,
        },
      );
      schedule.status = ScheduleStatus.SCHEDULED;
    } catch (e) {
      console.error(`Failed to queue job ${jobId}`, e);
      schedule.status = ScheduleStatus.FAILED;
    }
  }
}