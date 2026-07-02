import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health.indicator';
import { JobAlertService } from '../alert/service/alert.service';
import { HealthController } from './controller/health.controller';
import { RedisModule } from 'src/redis/redis.module';
import { EmailModule } from 'src/modules/email/email.module'; // <-- ADD
import { AlertModule } from '../alert/alert.module';

@Module({
  imports: [TerminusModule, RedisModule, AlertModule, EmailModule], // <-- ADD EmailModule
  controllers: [HealthController],
  providers: [RedisHealthIndicator, JobAlertService],
})
export class HealthModule {}