import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './controller/auth.controller';
import { AuthService } from './service/auth.service';


@Module({
  imports: [ConfigModule],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService], // export so AdsModule can call getValidAccessToken
})
export class AuthModule {}