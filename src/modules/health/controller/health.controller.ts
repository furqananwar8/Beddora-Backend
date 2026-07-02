import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { RedisHealthIndicator } from '../redis.health.indicator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly redisIndicator: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.redisIndicator.isHealthy('redis'),
      // Add DB check here if you have one:
      // () => this.db.pingCheck('database'),
    ]);
  }
}