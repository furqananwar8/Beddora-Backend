import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/redis/redis.provider';

export interface ProfileTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  region: string;
  countryCode: string;
  email: string;
  userId: string;
}

@Injectable()
export class ProfileTokenService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(profileId: number): string {
    return `profile-token-beddora:${profileId}`;
  }

  async create(profileId: number, data: ProfileTokenData, ttlSeconds: number): Promise<void> {
    await this.redis.setex(this.key(profileId), ttlSeconds, JSON.stringify(data));
  }

  async get(profileId: number): Promise<ProfileTokenData | null> {
    const raw = await this.redis.get(this.key(profileId));
    if (!raw) return null;
    return JSON.parse(raw) as ProfileTokenData;
  }

  async update(profileId: number, data: Partial<ProfileTokenData>, ttlSeconds: number): Promise<void> {
    const existing = await this.get(profileId);
    if (!existing) throw new Error('Profile token not found');
    await this.create(profileId, { ...existing, ...data }, ttlSeconds);
  }

  async delete(profileId: number): Promise<void> {
    await this.redis.del(this.key(profileId));
  }
}