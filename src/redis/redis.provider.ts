import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { redisRetryStrategy } from './redis-retry';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (config: ConfigService) => {
    const isSentinel = config.get('REDIS_SENTINEL_ENABLED') === 'true';

    const client = isSentinel
      ? new Redis({
          sentinels: [
            {
              host: config.get('REDIS_SENTINEL_HOST_1'),
              port: config.get<number>('REDIS_SENTINEL_PORT_1', 26379),
            },
            {
              host: config.get('REDIS_SENTINEL_HOST_2'),
              port: config.get<number>('REDIS_SENTINEL_PORT_2', 26379),
            },
          ],
          name: config.get('REDIS_SENTINEL_MASTER_NAME', 'mymaster'),
          password: config.get('REDIS_PASSWORD'),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          lazyConnect: true, // ← changed: don't crash on startup if Redis is down
          connectTimeout: 5000,
          commandTimeout: 5000, // fail fast instead of hanging while Redis is down
          retryStrategy: redisRetryStrategy('client'),
          sentinelRetryStrategy: redisRetryStrategy('client-sentinel'),
        })
      : new Redis({
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD'),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          lazyConnect: true,
          connectTimeout: 5000,
          commandTimeout: 5000, // fail fast instead of hanging while Redis is down
          retryStrategy: redisRetryStrategy('client'),
        });

    // 🔴 THIS IS THE FIX
    client.on('error', (err) => {
      console.error('[REDIS-CLIENT] Connection error (non-fatal):', err.message);
    });

    return client;
  },
  inject: [ConfigService],
};