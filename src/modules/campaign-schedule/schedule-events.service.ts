// src/campaign-schedule/schedule-events.service.ts
import { Injectable, OnModuleDestroy, Inject } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { map } from 'rxjs/operators';
import Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/redis/redis.provider';

export interface ScheduleEvent {
  type: 'SCHEDULE_EXECUTING' | 'SCHEDULE_COMPLETED' | 'SCHEDULE_FAILED';
  campaignScheduleId: number;
  campaignId: number;
  action: string;
  bidAdjustment?: number;
  timestamp: string;
  error?: string;
}

@Injectable()
export class ScheduleEventsService implements OnModuleDestroy {
  private readonly subscriber: Redis;
  private readonly events$ = new Subject<ScheduleEvent>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    // Dedicated subscriber connection (Redis protocol requirement)
    this.subscriber = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    });

    this.subscriber.subscribe('campaign-schedule-events');
    this.subscriber.on('message', (_channel, message) => {
      try {
        this.events$.next(JSON.parse(message));
      } catch {
        // ignore malformed
      }
    });
  }

  /** Called from the BullMQ worker process */
  publish(event: ScheduleEvent) {
    // Reuse the injected Redis client for publishing
    this.redis.publish('campaign-schedule-events', JSON.stringify(event));
  }

  /** Called from the SSE controller */
  getEvents(): Observable<{ data: ScheduleEvent }> {
    return this.events$.asObservable().pipe(
      map((payload) => ({ data: payload })),
    );
  }

  onModuleDestroy() {
    this.subscriber.disconnect();
  }
}