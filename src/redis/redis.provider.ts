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
          enableReadyCheck: true,
          lazyConnect: false,
        })
      : new Redis({
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD'),
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          lazyConnect: false,
        });

    return client;
  },
  inject: [ConfigService],
};