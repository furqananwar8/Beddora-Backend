// src/campaign-schedule/campaign-schedule.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { DateTime } from 'luxon';
import { ScheduleAction, ScheduleStatus } from 'src/common/enum/campaign.enum';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { CreateCampaignScheduleDto } from '../dto/campaign-schedule.dto';
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
  async schedule(campaignId: number, dto: CreateCampaignScheduleDto) {
    const scheduleDate = this.normalizeDate(dto.scheduleDate);
    const endDate = dto.endDate ? this.normalizeDate(dto.endDate) : undefined;

    const todayStr = DateTime.now().toISODate();

    const existing = await this.em.findOne(CampaignSchedule, {
      campaignId,
      scheduleDate: { $gte: todayStr },
      status: { $in: [ScheduleStatus.PENDING, ScheduleStatus.SCHEDULED] },
    });

    let schedule: CampaignSchedule;
    let isNew = false;

    if (!existing) {
      this.validateFuture(scheduleDate, dto.timeSlots, dto.timezone, campaignId);
      schedule = this.em.create(CampaignSchedule, {
        campaignId,
        scheduleDate,
        endDate: endDate ?? null,
        timeSlots: dto.timeSlots,
        timezone: dto.timezone,
        action: dto.action,
        status: ScheduleStatus.SCHEDULED,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      isNew = true;
    } else {
      const changed =
        existing.scheduleDate !== scheduleDate ||
        existing.endDate !== (endDate ?? null) ||
        existing.timezone !== dto.timezone ||
        existing.action !== dto.action ||
        JSON.stringify(existing.timeSlots) !== JSON.stringify(dto.timeSlots);

      if (!changed) {
        return { message: 'No changes detected', schedule: existing };
      }

      this.validateFuture(scheduleDate, dto.timeSlots, dto.timezone, campaignId);
      existing.scheduleDate = scheduleDate;
      if(endDate) existing.endDate = endDate;
      existing.timeSlots = dto.timeSlots;
      existing.timezone = dto.timezone;
      existing.action = dto.action;
      existing.status = ScheduleStatus.SCHEDULED;
      schedule = existing;
    }

    await this.em.flush();

    if (existing) {
      await this.removeJob(existing.id);
    }
    await this.upsertJob(schedule);
    await this.em.flush();

    return {
      message: isNew ? 'Campaign scheduled' : 'Schedule updated',
      schedule,
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