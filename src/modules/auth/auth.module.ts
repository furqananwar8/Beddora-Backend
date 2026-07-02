import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './controller/auth.controller';
import { AuthService } from './service/auth.service';
import { BullModule } from '@nestjs/bullmq';
import { AMAZON_PROFILE_TOKEN_REFRESH, AMAZON_TOKEN_REFRESH } from 'src/common/constants/bullmq.constant';
import { AmazonTokenRefreshProcessor } from './amazon-token-refresh-worker';
import { HttpModule } from '@nestjs/axios';
import { ProfileTokenService } from '../session/service/profile-token.service';
import { AmazonProfileTokenRefreshProcessor } from './amazon-profile-token-refresh.processor';
import { RedisModule } from 'src/redis/redis.module';

@Module({
  imports: [
    ConfigModule,
    RedisModule,
      BullModule.registerQueue({
      name: AMAZON_TOKEN_REFRESH,
      defaultJobOptions: {
        removeOnComplete: { count: 1, age: 7200 },
        removeOnFail: { count: 5, age: 7200 },
      },
    }),
    BullModule.registerQueue({
      name: AMAZON_PROFILE_TOKEN_REFRESH,
      defaultJobOptions: {
        removeOnComplete: { count: 1, age: 7200 },
        removeOnFail: { count: 5, age: 7200 },
      },
    }),
    HttpModule
  ],
   providers: [
    AuthService,
    ProfileTokenService,
    AmazonTokenRefreshProcessor,
    AmazonProfileTokenRefreshProcessor,
  ],
  controllers: [AuthController],
  exports: [AuthService], // export so AdsModule can call getValidAccessToken
})
export class AuthModule {}