import { Injectable, Inject } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';
import { JobAlertService } from '../alert/service/alert.service';
import { REDIS_CLIENT } from 'src/redis/redis.provider';


@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  private alertSent = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly alertService: JobAlertService,
  ) {
    super();

    this.redis.on('error', async () => {
      if (!this.alertSent) {
        this.alertSent = true;
        await this.alertService.sendRedisDownAlert().catch(() => {
          // Don't let email failures crash the health indicator
        });
      }
    });

    this.redis.on('connect', () => {
      this.alertSent = false;
    });
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.redis.ping();
      return this.getStatus(key, true);
    } catch (error: any) {
      return this.getStatus(key, false, { message: error.message });
    }
  }
}