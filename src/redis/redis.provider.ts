import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

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
          retryStrategy: (times) => {
            if (times > 3) {
              console.log('[REDIS] Max retries (3) reached, stopping reconnection attempts');
              return null; // null = stop retrying
            }
            const delay = Math.min(times * 1000, 3000); // 1s, 2s, 3s
            console.log(`[REDIS] Reconnect attempt ${times}/3 in ${delay}ms`);
            return delay;
          },
        })
      : new Redis({
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD'),
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          lazyConnect: true,
          connectTimeout: 5000,
          retryStrategy: (times) => {
            if (times > 3) {
              console.log('[REDIS] Max retries (3) reached, stopping reconnection attempts');
              return null; // null = stop retrying
            }
            const delay = Math.min(times * 1000, 3000); // 1s, 2s, 3s
            console.log(`[REDIS] Reconnect attempt ${times}/3 in ${delay}ms`);
            return delay;
          },
        });

    // 🔴 THIS IS THE FIX
    client.on('error', (err) => {
      console.error('[REDIS-CLIENT] Connection error (non-fatal):', err.message);
    });

    return client;
  },
  inject: [ConfigService],
};