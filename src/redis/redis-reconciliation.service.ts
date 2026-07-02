import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { EntityManager } from '@mikro-orm/core';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { JobAlertService } from 'src/modules/alert/service/alert.service';

@Injectable()
export class RedisReconciliationService {
  private readonly logger = new Logger(RedisReconciliationService.name);

  constructor(
    @InjectQueue('campaign-scheduler') private readonly queue: Queue,
    private readonly em: EntityManager,
    private readonly alertService: JobAlertService,
  ) {}

  async reconcileOnConnect(): Promise<void> {
    this.logger.log('[RECONCILE] Starting post-outage cleanup...');

    // STEP 1: Find jobs that were in the alert email AND missed their window
    const missedAlertedJobs = await this.alertService.getMissedAlertedJobs();
    this.logger.log(`[RECONCILE] ${missedAlertedJobs.length} alerted jobs missed their window`);

    for (const job of missedAlertedJobs) {
      const bullJobId = `schedule-${job.id}`;
      try {
        const bullJob = await this.queue.getJob(bullJobId);
        if (bullJob) {
          await bullJob.remove();
          this.logger.log(
            `[RECONCILE] 🧹 Removed missed job ${bullJobId} (executeAt=${job.executeAt?.toISOString()})`
          );
        }

        job.status = 'cancelled';
        job.errorMessage = 'Cancelled: Redis outage, admin notified, job missed window';
        await this.em.flush();
      } catch (err: any) {
        this.logger.error(`[RECONCILE] Failed to clean up job ${job.id}: ${err.message}`);
      }
    }

    // STEP 2: General zombie cleanup
    await this.cleanupZombies();

    // STEP 3: Log surviving jobs that were in alert but still scheduled
    const survivingJobs = await this.alertService.getSurvivingAlertedJobs();
    this.logger.log(
      `[RECONCILE] ${survivingJobs.length} alerted jobs still scheduled for future execution`
    );

    this.logger.log('[RECONCILE] Cleanup complete.');
  }

  private async cleanupZombies(): Promise<void> {
    const [delayed, waiting] = await Promise.all([
      this.queue.getJobs('delayed'),
      this.queue.getJobs('waiting'),
    ]);

    const allJobs = [...delayed, ...waiting];
    if (allJobs.length === 0) {
      this.logger.log('[RECONCILE] No jobs in queues, nothing to clean.');
      return;
    }

    const jobIds = allJobs
      .map((j) => j.id)
      .filter(Boolean)
      .map((id) => Number(id))
      .filter((id) => !isNaN(id));

    if (jobIds.length === 0) {
      this.logger.log('[RECONCILE] No valid numeric job IDs found.');
      return;
    }

    const validJobs = await this.em.find(
      ScheduleJob,
      {
        id: { $in: jobIds },
        status: { $nin: ['cancelled', 'completed', 'failed'] },
      },
      { fields: ['id'] },
    );

    const validIds = new Set(validJobs.map((j) => j.id));
    const zombies = allJobs.filter((j) => {
      const numId = Number(j.id);
      return !isNaN(numId) && !validIds.has(numId);
    });

    this.logger.log(`[RECONCILE] ${zombies.length} zombie jobs identified`);

    for (const zombie of zombies) {
      try {
        await zombie.remove();
        this.logger.log(`[RECONCILE] 🧹 Removed zombie job ${zombie.id}`);
      } catch (err: any) {
        this.logger.error(`[RECONCILE] Failed to remove zombie ${zombie.id}: ${err.message}`);
      }
    }
  }
}