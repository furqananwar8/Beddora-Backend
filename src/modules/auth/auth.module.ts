import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './controller/auth.controller';
import { AuthService } from './service/auth.service';
import { BullModule } from '@nestjs/bullmq';
import { AMAZON_TOKEN_REFRESH } from 'src/common/constants/bullmq.constant';
import { AmazonTokenRefreshProcessor } from './amazon-token-refresh-worker';


@Module({
  imports: [ConfigModule, BullModule.registerQueue({
    name: AMAZON_TOKEN_REFRESH
  })],
  providers: [AuthService, AmazonTokenRefreshProcessor],
  controllers: [AuthController],
  exports: [AuthService], // export so AdsModule can call getValidAccessToken
})
export class AuthModule {}