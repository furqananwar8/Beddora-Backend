import { Injectable, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/redis/redis.provider';

export interface SessionData {
  access_token: string;
  userId: number;
  refresh_token: string;
  token_type: string;
  expires_at: number; // unix timestamp ms
  user_id?: string;   // Amazon user ID (from /user/profile if needed)
}

@Injectable()
export class SessionService  {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async create(sessionId: string, data: SessionData, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      `session:${sessionId}`,
      JSON.stringify(data),
      'EX',
      ttlSeconds,
    );
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.redis.get(`session:${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as SessionData;
  }

  async update(sessionId: string, data: Partial<SessionData>, ttlSeconds: number): Promise<void> {
    const existing = await this.get(sessionId);
    if (!existing) throw new Error('Session not found');
    await this.create(sessionId, { ...existing, ...data }, ttlSeconds);
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(`session:${sessionId}`);
  }
}