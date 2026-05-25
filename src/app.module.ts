// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { RedisModule } from './redis/redis.module';
import { SessionModule } from './modules/session/session.module';
import { AuthModule } from './modules/auth/auth.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { REDIS_CLIENT } from './redis/redis.provider';
import Redis from 'ioredis';
import { AMAZON_TOKEN_REFRESH } from './common/constants/bullmq.constant';
import { CampaignModule } from './modules/campaign/campaign.module';
import { CampaignScheduleModule } from './modules/campaign-schedule/campaign-schedule.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule, // <-- shared Redis connection
    
    BullModule.forRootAsync({
      imports: [RedisModule],
      useFactory: (redis: Redis) => ({
        connection: redis,
      }),
      inject: [REDIS_CLIENT],
    }),
    
    BullModule.registerQueue({
      name: AMAZON_TOKEN_REFRESH,
    }),
    
    MikroOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        driver: PostgreSqlDriver,
        host: config.get('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        user: config.get('DB_USER'),
        password: config.get('DB_PASSWORD'),
        dbName: config.get('DB_NAME'),
        entities: ['./dist/**/*.entity.js'],
        entitiesTs: ['./src/**/*.entity.ts'],
        debug: config.get('NODE_ENV') !== 'production',
        autoLoadEntities: true,
      }),
    }),
    
    SessionModule,
    AuthModule,
    CampaignModule,
    CampaignScheduleModule
  ],
  providers: [AppService],
  controllers: [AppController],
})
export class AppModule {}