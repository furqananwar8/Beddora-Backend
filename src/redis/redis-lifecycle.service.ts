import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.provider';
import { RedisReconciliationService } from './redis-reconciliation.service';

@Injectable()
export class RedisLifecycleService implements OnModuleInit {
  private readonly logger = new Logger(RedisLifecycleService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly reconciliation: RedisReconciliationService,
  ) {}

  onModuleInit(): void {
    this.redis.on('connect', () => {
      this.logger.log('[REDIS] Connection restored, scheduling reconciliation in 2s...');
      setTimeout(() => {
        this.reconciliation
          .reconcileOnConnect()
          .catch((err) => this.logger.error('[REDIS] Reconciliation failed', err));
      }, 2000);
    });

    this.redis.on('error', (err) => {
      this.logger.error(`[REDIS] Connection error: ${err.message}`);
    });
  }
}