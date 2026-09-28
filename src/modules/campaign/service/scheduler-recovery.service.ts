import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { ProfileTokenService } from 'src/modules/session/service/profile-token.service';
import { TARGET_TZ } from 'src/common/constants/bullmq.constant';
import { ScheduleExpanderService } from './schedule-expander.service';

/** A job this late (and not live in BullMQ) is considered missed. */
const MISSED_GRACE_MS = 15 * 60 * 1000;
const LIVE_STATES = new Set(['delayed', 'waiting', 'active', 'prioritized', 'waiting-children']);

/**
 * Brings the scheduler back to a correct state after downtime / Redis loss.
 * Runs on boot, whenever Redis (re)connects, and the chain repair every 30 min.
 *
 *  1. ensureTokens     – make sure every scheduled profile has a valid Amazon
 *                        token right away (refresh from Redis, else Postgres).
 *  2. catchUpToday     – per campaign, re-run only its LATEST job of today (PT)
 *                        if it failed or was missed, so the campaign ends up in
 *                        the state it should be in now. Earlier days are not re-run.
 *  3. reconcileChains  – every active schedule must have a future slot_start and
 *                        slot_end job; recreate any chain that died.
 */
@Injectable()
export class SchedulerRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerRecoveryService.name);
  private running: Promise<void> | null = null;
  private lastRecoveryAt = 0;

  constructor(
    private readonly em: EntityManager,
    private readonly expander: ScheduleExpanderService,
    private readonly profileTokenService: ProfileTokenService,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {}

  onApplicationBootstrap(): void {
    // Don't block Nest startup; give Redis/BullMQ a moment to connect.
    setTimeout(() => void this.recover('startup'), 5000);
  }

  /** Full recovery (tokens → today's catch-up → chains). Coalesces concurrent triggers. */
  recover(reason: string): Promise<void> {
    if (this.running) return this.running;
    if (Date.now() - this.lastRecoveryAt < 30_000) {
      this.logger.log(`[RECOVERY] Skipping '${reason}' — recovery ran <30s ago`);
      return Promise.resolve();
    }
    this.running = (async () => {
      this.logger.log(`[RECOVERY] ▶ Starting recovery (${reason})`);
      await this.step('ensureTokens', () => this.ensureTokens());
      await this.step('catchUpToday', () => this.catchUpToday());
      await this.step('reconcileChains', () => this.reconcileChains());
      this.logger.log(`[RECOVERY] ■ Recovery finished (${reason})`);
    })().finally(() => {
      this.running = null;
      this.lastRecoveryAt = Date.now();
    });
    return this.running;
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async periodicChainRepair(): Promise<void> {
    if (this.running) return;
    await this.step('reconcileChains (periodic)', () => this.reconcileChains());
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err: any) {
      this.logger.error(`[RECOVERY] Step ${name} failed: ${err.message}`, err.stack);
    }
  }

  // ── 1. Tokens ────────────────────────────────────────────────────────────

  async ensureTokens(): Promise<void> {
    const em = this.em.fork();
    const schedules = await em.find(CampaignSchedule, { isActive: true }, { fields: ['profileId'] });
    const profileIds = new Set<number>(schedules.map((s) => Number(s.profileId)));
    for (const id of await this.profileTokenService.listDurableProfileIds()) profileIds.add(id);

    for (const profileId of profileIds) {
      try {
        const token = await this.profileTokenService.getValidToken(profileId);
        if (token) {
          this.logger.log(`[RECOVERY] ✅ Token OK for profile ${profileId}`);
        } else {
          this.logger.warn(`[RECOVERY] ❌ No usable token for profile ${profileId} — user must reconnect Amazon`);
        }
      } catch (err: any) {
        this.logger.error(`[RECOVERY] Token refresh failed for profile ${profileId}: ${err.message}`);
      }
    }
  }

  // ── 2. Today's catch-up ──────────────────────────────────────────────────

  async catchUpToday(): Promise<void> {
    const em = this.em.fork();
    const now = new Date();
    const missedBefore = new Date(now.getTime() - MISSED_GRACE_MS);
    const todayStart = fromZonedTime(`${formatInTimeZone(now, TARGET_TZ, 'yyyy-MM-dd')}T00:00:00`, TARGET_TZ);

    // Today's jobs that were due by now, newest first, for active schedules.
    const todays = await em.find(
      ScheduleJob,
      { executeAt: { $gte: todayStart, $lte: now }, schedule: { isActive: true } },
      { orderBy: { executeAt: 'desc', id: 'desc' } },
    );

    const latestByCampaign = new Map<string, ScheduleJob>();
    for (const job of todays) {
      const key = `${job.profileId}|${job.campaignId}`;
      if (!latestByCampaign.has(key)) latestByCampaign.set(key, job);
    }

    const rerunIds = new Set<number>();
    for (const job of latestByCampaign.values()) {
      if (!(await this.isMissedOrFailed(job, missedBefore))) continue;

      job.status = 'pending';
      job.errorMessage = null;
      await em.flush();
      await this.expander.ensureEnqueued(em, job); // delay 0 → runs now
      rerunIds.add(job.id);
      this.logger.log(
        `[RECOVERY] 🔁 Re-running ${job.action} for campaign ${job.campaignName ?? job.campaignId} ` +
          `(job ${job.id}, was due ${job.executeAt?.toISOString()})`,
      );
    }

    // Everything else that was missed (earlier today, or previous days) is not
    // re-run; mark it so it stops looking pending/processing forever.
    const stale = await em.find(ScheduleJob, {
      $or: [
        { status: 'pending', executeAt: { $lt: missedBefore } },
        { status: 'processing', updatedAt: { $lt: missedBefore } },
      ],
    });
    let expired = 0;
    for (const job of stale) {
      if (rerunIds.has(job.id)) continue;
      if (job.status === 'pending' && (await this.isLiveInQueue(job))) continue; // BullMQ will still run it
      job.status = 'expired';
      job.errorMessage = 'Missed execution window (server/queue unavailable); not re-run';
      expired++;
    }
    await em.flush();

    this.logger.log(`[RECOVERY] Catch-up: re-ran ${rerunIds.size} of today's jobs, expired ${expired} missed jobs`);
  }

  private async isMissedOrFailed(job: ScheduleJob, missedBefore: Date): Promise<boolean> {
    switch (job.status) {
      case 'failed':
      case 'expired':
        return true;
      case 'processing':
        return !!job.updatedAt && job.updatedAt < missedBefore;
      case 'pending':
        return !!job.executeAt && job.executeAt < missedBefore && !(await this.isLiveInQueue(job));
      default:
        return false; // completed / cancelled
    }
  }

  private async isLiveInQueue(job: ScheduleJob): Promise<boolean> {
    const bullJob = await this.schedulerQueue.getJob(`schedule-${job.id}`);
    return !!bullJob && LIVE_STATES.has(await bullJob.getState());
  }

  // ── 3. Chain repair ──────────────────────────────────────────────────────

  async reconcileChains(): Promise<void> {
    const schedules = await this.em.fork().find(CampaignSchedule, { isActive: true });
    if (schedules.length === 0) return;

    // Same logic Save uses for unchanged slots (ScheduleExpanderService).
    const repaired = await this.expander.ensureChainsFor(schedules, '[RECOVERY]');
    this.logger.log(`[RECOVERY] Chain repair: ${repaired} chain(s) restored across ${schedules.length} active schedules`);
  }
}
