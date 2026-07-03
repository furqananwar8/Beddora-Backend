// src/modules/campaign/service/startup-check.service.ts
import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JobAlertService } from 'src/modules/alert/service/alert.service';
import { ScheduleJob } from 'src/entities/schedule-job.entity';

@Injectable()
export class StartupCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupCheckService.name);

  constructor(
    private readonly em: EntityManager,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
    private readonly jobAlertService: JobAlertService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('[STARTUP] Running initial orphan check...');
    
    const em = this.em.fork();
    const now = Date.now();
    const oneHourFromNow = new Date(now + 60 * 60 * 1000);

    const orphaned = await em.find(ScheduleJob, {
      status: 'pending',
      bullJobId: null,
      executeAt: { $lte: oneHourFromNow },
    });

    if (orphaned.length === 0) {
      this.logger.log('[STARTUP] No at-risk orphans found');
      return;
    }

    this.logger.log(`[STARTUP] Found ${orphaned.length} at-risk orphans`);

    let redisDown = false;

    for (const job of orphaned) {
      const bullJobId = `schedule-${job.id}`;
      try {
        this.logger.log(`[STARTUP] Checking job ${job.id}, calling getJob...`);
        const existing = await this.schedulerQueue.getJob(bullJobId);
        this.logger.log(`[STARTUP] getJob result: ${existing ? 'FOUND' : 'NOT FOUND'}`);
        
        if (existing) {
          job.bullJobId = bullJobId;
          await em.flush();
          continue;
        }
        
        this.logger.log(`[STARTUP] Calling add for ${bullJobId}...`);
        await this.schedulerQueue.add('execute', { jobId: job.id }, {
          delay: Math.max(0, job.executeAt!.getTime() - now),
          jobId: bullJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 60000 },
        });
        
        job.bullJobId = bullJobId;
        await em.flush();
        this.logger.log(`[STARTUP] ✅ Enqueued job ${job.id}`);

      } catch (err: any) {
        this.logger.error(`[STARTUP] ❌ Redis down for job ${job.id}: ${err.message}`);
        redisDown = true;
        break;
      }
    }

    if (redisDown) {
      try {
        await this.jobAlertService.sendRedisDownAlert();
        this.logger.log('[STARTUP] 🚨 Redis down alert sent');
      } catch (alertErr: any) {
        this.logger.error(`[STARTUP] Failed to send alert: ${alertErr.message}`);
      }
    }
  }
}