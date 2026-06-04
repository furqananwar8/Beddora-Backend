import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class ScheduleExpanderService {
  constructor(
    private readonly em: EntityManager,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {}

  async expandAndQueue(
    campaignId: string,
    profileId: number,
    region: string,
    sessionId: string,
    schedules: Array<{
      scheduleDate: string;
      endDate?: string;
      timeSlots: Array<{ startTime: string; endTime: string }>;
      action: 'ENABLED' | 'PAUSED';
    }>,
  ): Promise<{ schedulesCreated: number; jobsCreated: number }> {
    const em = this.em.fork();
    let totalJobs = 0;
    const jobsToQueue: Array<{ job: ScheduleJob; delay: number }> = [];

    for (const cfg of schedules) {
      const schedule = em.create(CampaignSchedule, {
        campaignId,
        profileId,
        region,
        sessionId,
        scheduleDate: cfg.scheduleDate,
        endDate: cfg.endDate,
        timeSlots: cfg.timeSlots,
        action: cfg.action,
      });
      em.persist(schedule);

      const start = this.parseYmd(cfg.scheduleDate);
      const end = cfg.endDate ? this.parseYmd(cfg.endDate) : new Date(start);
      const dates: Date[] = [];

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(new Date(d));
      }

      for (const date of dates) {
        for (const slot of cfg.timeSlots) {
          const startAt = this.combineDateTime(date, slot.startTime);
          let endAt = this.combineDateTime(date, slot.endTime);

          if (endAt <= startAt) {
            endAt.setDate(endAt.getDate() + 1);
          }

          const { startAction, endAction } = this.resolveActions(cfg.action);

          const startJob = em.create(ScheduleJob, {
            schedule,
            campaignId,
            profileId,
            region,
            executeAt: startAt,
            jobType: 'slot_start',
            action: startAction,
          });
          em.persist(startJob);
          totalJobs++;
          jobsToQueue.push({ job: startJob, delay: startAt.getTime() - Date.now() });

          const endJob = em.create(ScheduleJob, {
            schedule,
            campaignId,
            profileId,
            region,
            executeAt: endAt,
            jobType: 'slot_end',
            action: endAction,
          });
          em.persist(endJob);
          totalJobs++;
          jobsToQueue.push({ job: endJob, delay: endAt.getTime() - Date.now() });
        }
      }
    }

    await em.flush();

    for (const item of jobsToQueue) {
        const executeAt = item.job.executeAt;
        if (!executeAt) continue; // type guard — satisfies TS
        const delay = executeAt.getTime() - Date.now();
        if (delay > 0) {
            await this.schedulerQueue.add(
            'execute',
            { jobId: item.job.id },
            { delay, jobId: `schedule-${item.job.id}` },
            );
        }
    }

    return { schedulesCreated: schedules.length, jobsCreated: totalJobs };
  }

  private parseYmd(str: string): Date {
    const y = parseInt(str.slice(0, 4), 10);
    const m = parseInt(str.slice(4, 6), 10) - 1;
    const d = parseInt(str.slice(6, 8), 10);
    return new Date(Date.UTC(y, m, d));
  }

  private combineDateTime(date: Date, time: string): Date {
    const [h, min] = time.split(':').map(Number);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, min));
  }

  private resolveActions(userAction: 'ENABLED' | 'PAUSED') {
    if (userAction === 'ENABLED') {
      return { startAction: 'ENABLE' as const, endAction: 'PAUSE' as const };
    }
    return { startAction: 'PAUSE' as const, endAction: 'ENABLE' as const };
  }
}