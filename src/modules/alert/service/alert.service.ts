import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/core';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { EmailService } from 'src/modules/email/service/email.service';
import { toZonedTime, fromZonedTime, format } from 'date-fns-tz';
import { TARGET_TZ } from 'src/common/constants/bullmq.constant';

@Injectable()
export class JobAlertService {
  private readonly logger = new Logger(JobAlertService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async sendRedisDownAlert(): Promise<void> {
    const nowUtc = this.getUtcNow();
    const nowPst = toZonedTime(nowUtc, TARGET_TZ);
    const downSincePst = format(nowPst, 'yyyy-MM-dd HH:mm:ss zzz', { timeZone: TARGET_TZ });

    const atRiskJobs = await this.findAtRiskPauseJobs(nowUtc);

    if (atRiskJobs.length === 0) {
      this.logger.log('[ALERT] No at-risk jobs found, skipping alert');
      return;
    }

    const adminEmailsRaw = this.configService.get<string>('ADMIN_EMAIL');
    if (!adminEmailsRaw) {
      this.logger.warn('[ALERT] ADMIN_EMAIL not configured');
      return;
    }

    const adminEmails = adminEmailsRaw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);

    if (adminEmails.length === 0) {
      this.logger.warn('[ALERT] No valid admin emails');
      return;
    }

    const em = this.em.fork();
    for (const job of atRiskJobs) {
      job.redisAlertSentAt = nowUtc;
    }
    await em.flush();

    try {
      await (this.emailService as any).sendFailedJobEmail?.({
        to: adminEmails,
        subject: `🚨 Redis Down — ${atRiskJobs.length} Pause Jobs At Risk`,
        template: 'redis-down-alert',
        context: {
          downSince: downSincePst,
          jobCount: atRiskJobs.length,
          jobs: atRiskJobs.map((j) => ({
            id: j.id,
            campaignId: j.campaignId,
            campaignName: j.campaignName || 'Unnamed',
            action: j.action,
            scheduledAt: j.executeAt
              ? format(toZonedTime(j.executeAt, TARGET_TZ), 'yyyy-MM-dd HH:mm:ss zzz', { timeZone: TARGET_TZ })
              : 'N/A',
            status: j.executeAt && j.executeAt.getTime() < nowUtc.getTime()
              ? 'OVERDUE — pause now!'
              : 'Upcoming',
          })),
        },
      });

      this.logger.log(`[ALERT] ✅ Alert sent to ${adminEmails.join(', ')} for ${atRiskJobs.length} jobs`);
    } catch (err: any) {
      this.logger.error(`[ALERT] ❌ Failed to send alert: ${err.message}`);
    }
  }

  private async findAtRiskPauseJobs(now: Date): Promise<ScheduleJob[]> {
    const em = this.em.fork();

    const enabledJobs = await em.find(
      ScheduleJob,
      {
        action: 'ENABLE',
        status: 'completed',
        jobType: 'slot_start',
      },
      { populate: ['schedule'] },
    );

    const atRisk: ScheduleJob[] = [];

    for (const enableJob of enabledJobs) {
      const pauseJob = await em.findOne(ScheduleJob, {
        schedule: enableJob.schedule,
        action: 'PAUSE',
        jobType: 'slot_end',
        status: 'pending',
      });

      if (pauseJob) {
        atRisk.push(pauseJob);
      }
    }

    return atRisk;
  }

  /**
   * Jobs that were in the alert email AND have missed their execution window.
   * executeAt <= now → should have run already but didn't
   */
  async getMissedAlertedJobs(): Promise<ScheduleJob[]> {
    const em = this.em.fork();  // ← ADD THIS
    const now = this.getUtcNow();
    return em.find(ScheduleJob, {  // ← Use forked EM
      redisAlertSentAt: { $ne: null },
      status: 'pending',
      executeAt: { $lte: now },
    });
  }

  /**
   * Jobs that were in the alert email but are still pending and in the future.
   * executeAt > now → can still run normally
   */

  async getSurvivingAlertedJobs(): Promise<ScheduleJob[]> {
    const em = this.em.fork();  // ← ADD THIS
    const now = this.getUtcNow();
    return em.find(ScheduleJob, {  // ← Use forked EM
      redisAlertSentAt: { $ne: null },
      status: 'pending',
      executeAt: { $gt: now },
    });
  }

  /**
   * Consistent UTC timestamp using the same date-fns-tz pipeline as scheduling.
   */
  private getUtcNow(): Date {
    return fromZonedTime(toZonedTime(new Date(), TARGET_TZ), TARGET_TZ);
  }
}