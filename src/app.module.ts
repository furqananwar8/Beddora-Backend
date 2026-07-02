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
import { AMAZON_TOKEN_REFRESH } from './common/constants/bullmq.constant';
import { CampaignModule } from './modules/campaign/campaign.module';
import { EmailModule } from './modules/email/email.module';
import { UserModule } from './modules/user/user.module';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    RedisModule,
    HealthModule,
    EmailModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const isSentinel = config.get('REDIS_SENTINEL_ENABLED') === 'true';

        if (isSentinel) {
          return {
            connection: {
              sentinels: [
                {
                  host: config.get('REDIS_SENTINEL_HOST_1'),
                  port: config.get<number>('REDIS_SENTINEL_PORT_1', 26479),
                },
                {
                  host: config.get('REDIS_SENTINEL_HOST_2'),
                  port: config.get<number>('REDIS_SENTINEL_PORT_2', 26480),
                },
              ],
              name: config.get('REDIS_SENTINEL_MASTER_NAME', 'mymaster'),
              maxRetriesPerRequest: null,
              enableReadyCheck: false,
            },
          };
        }

        return {
          connection: {
            host: config.get('REDIS_HOST', 'localhost'),
            port: config.get<number>('REDIS_PORT', 6379),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          },
        };
      },
      inject: [ConfigService],
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
    UserModule
  ],
  providers: [AppService],
  controllers: [AppController],
})
export class AppModule {}