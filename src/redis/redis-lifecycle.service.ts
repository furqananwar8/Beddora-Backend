import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.provider';
import { RedisReconciliationService } from './redis-reconciliation.service';
import { SchedulerRecoveryService } from 'src/modules/campaign/service/scheduler-recovery.service';

@Injectable()
export class RedisLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(RedisLifecycleService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly reconciliation: RedisReconciliationService,
    private readonly recovery: SchedulerRecoveryService,
  ) {}

  onModuleInit(): void {
    this.redis.on('connect', () => {
      this.logger.log('[REDIS] Connection restored, scheduling reconciliation in 2s...');
      setTimeout(() => {
        this.reconciliation
          .reconcileOnConnect()
          .catch((err) => this.logger.error('[REDIS] Reconciliation failed', err))
          // Redis is live again: refresh tokens right away, catch up today's
          // failed/missed jobs and restore any broken weekly chains.
          .then(() => this.recovery.recover('redis-connect'))
          .catch((err) => this.logger.error('[REDIS] Scheduler recovery failed', err));
      }, 2000);
    });

    this.redis.on('error', (err) => {
      this.logger.error(`[REDIS] Connection error: ${err.message}`);
    });
  }
}