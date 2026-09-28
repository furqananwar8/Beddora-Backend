import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/core';
import Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/redis/redis.provider';
import { AmazonProfileToken } from 'src/entities/amazon-profile-token.entity';
import { decryptToken, encryptToken, parseEncryptionKey } from './token-crypto';
import { isPermanentRefreshError, requestAmazonTokenRefresh } from './amazon-lwa';

export interface ProfileTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  region: string;
  countryCode: string;
  email: string;
  userId: string;
}

/** Refresh a little before Amazon's expiry so in-flight calls never use a dying token. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

@Injectable()
export class ProfileTokenService {
  private readonly logger = new Logger(ProfileTokenService.name);
  private readonly encryptionKey: Buffer | null;
  /** One refresh per profile at a time; concurrent callers share the result. */
  private readonly inflight = new Map<number, Promise<ProfileTokenData | null>>();
  private readonly persistedThisProcess = new Set<number>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly em: EntityManager,
    private readonly config: ConfigService,
  ) {
    this.encryptionKey = parseEncryptionKey(this.config.get<string>('TOKEN_ENCRYPTION_KEY'));
    if (!this.encryptionKey) {
      this.logger.warn(
        '[TOKEN] TOKEN_ENCRYPTION_KEY missing or not 32 bytes (base64). ' +
          'Refresh tokens will NOT be persisted to Postgres; recovery after Redis loss is disabled.',
      );
    }
  }

  private key(profileId: number): string {
    return `profile-token-beddora:${profileId}`;
  }

  /**
   * Stored WITHOUT a TTL: the key holds the long-lived refresh token, so it
   * must survive downtime. Access-token validity is tracked by `expires_at`.
   * `_ttlSeconds` is kept for call-site compatibility and ignored.
   */
  async create(profileId: number, data: ProfileTokenData, _ttlSeconds?: number): Promise<void> {
    await this.redis.set(this.key(profileId), JSON.stringify(data));
    await this.persistDurable(profileId, data);
  }

  /** Redis only (fast path). Prefer getValidToken() when you need a usable access token. */
  async get(profileId: number): Promise<ProfileTokenData | null> {
    const raw = await this.redis.get(this.key(profileId));
    if (!raw) return null;
    return JSON.parse(raw) as ProfileTokenData;
  }

  async update(profileId: number, data: Partial<ProfileTokenData>, _ttlSeconds?: number): Promise<void> {
    const existing = await this.get(profileId);
    if (!existing) throw new Error('Profile token not found');
    await this.create(profileId, { ...existing, ...data });
  }

  /** Disconnect: removes both the Redis key and the durable copy. */
  async delete(profileId: number): Promise<void> {
    await this.redis.del(this.key(profileId));
    await this.em.fork().nativeDelete(AmazonProfileToken, { profileId });
  }

  /**
   * Returns a token whose access_token is valid, refreshing it if needed.
   * Source of the refresh token: Redis first, Postgres fallback.
   * Returns null only when there is no refresh token anywhere or Amazon
   * rejected it permanently (user must reconnect). Throws on transient
   * refresh errors so callers (BullMQ) retry.
   */
  async getValidToken(rawProfileId: number | string, opts: { forceRefresh?: boolean } = {}): Promise<ProfileTokenData | null> {
    const profileId = Number(rawProfileId); // bigint columns can arrive as strings
    const cached = await this.get(profileId);
    if (!opts.forceRefresh && cached?.access_token && cached.expires_at - EXPIRY_SKEW_MS > Date.now()) {
      return cached;
    }

    const pending = this.inflight.get(profileId);
    if (pending) return pending;

    const run = this.refresh(profileId, cached).finally(() => this.inflight.delete(profileId));
    this.inflight.set(profileId, run);
    return run;
  }

  /** Profile ids we hold a durable refresh token for. */
  async listDurableProfileIds(): Promise<number[]> {
    const rows = await this.em.fork().find(AmazonProfileToken, {}, { fields: ['profileId'] });
    return rows.map((r) => Number(r.profileId));
  }

  private async refresh(profileId: number, cached: ProfileTokenData | null): Promise<ProfileTokenData | null> {
    const base = cached ?? (await this.loadDurable(profileId));
    if (!base?.refresh_token) {
      this.logger.warn(`[TOKEN] No refresh token for profile ${profileId} in Redis or Postgres — user must reconnect Amazon`);
      return null;
    }
    const source = cached ? 'redis' : 'postgres';

    const res = await requestAmazonTokenRefresh(this.config, base.refresh_token);
    if (res.error || !res.access_token) {
      if (isPermanentRefreshError(res.error)) {
        this.logger.error(`[TOKEN] Refresh token for profile ${profileId} rejected (${res.error}); removing it — user must reconnect Amazon`);
        await this.delete(profileId);
        return null;
      }
      // Transient: keep the stored refresh token so the next attempt can succeed.
      throw new Error(`Amazon token refresh failed for profile ${profileId}: ${res.error ?? 'no access_token in response'}`);
    }

    const data: ProfileTokenData = {
      ...base,
      access_token: res.access_token,
      refresh_token: res.refresh_token ?? base.refresh_token,
      expires_at: Date.now() + (res.expires_in ?? 3600) * 1000,
    };
    await this.redis.set(this.key(profileId), JSON.stringify(data));
    // Touch Postgres when the refresh token changed, Redis had lost it, or this
    // process hasn't written it yet (backfills tokens created before this change).
    if (!cached || data.refresh_token !== base.refresh_token || !this.persistedThisProcess.has(profileId)) {
      await this.persistDurable(profileId, data);
    }

    this.logger.log(`[TOKEN] Refreshed access token for profile ${profileId} (refresh token from ${source})`);
    return data;
  }

  private async persistDurable(profileId: number, data: ProfileTokenData): Promise<void> {
    if (!this.encryptionKey || !data.refresh_token) return;
    try {
      // Explicit find → update/create: em.upsert() with a plain object skips
      // entity defaults (created_at), which violated NOT NULL on insert.
      const em = this.em.fork();
      const fields = {
        refreshTokenEncrypted: encryptToken(data.refresh_token, this.encryptionKey),
        region: data.region,
        countryCode: data.countryCode,
        email: data.email,
        userId: data.userId,
      };
      const existing = await em.findOne(AmazonProfileToken, { profileId });
      if (existing) {
        em.assign(existing, fields);
      } else {
        em.create(AmazonProfileToken, { profileId, ...fields });
      }
      await em.flush();
      this.persistedThisProcess.add(Number(profileId));
    } catch (err: any) {
      // Never break login/refresh because the fallback copy couldn't be written.
      this.logger.error(`[TOKEN] Failed to persist durable refresh token for profile ${profileId}: ${err.message}`);
    }
  }

  private async loadDurable(profileId: number): Promise<ProfileTokenData | null> {
    if (!this.encryptionKey) return null;
    const row = await this.em.fork().findOne(AmazonProfileToken, { profileId });
    if (!row) return null;
    try {
      return {
        access_token: '',
        refresh_token: decryptToken(row.refreshTokenEncrypted, this.encryptionKey),
        expires_at: 0,
        region: row.region ?? '',
        countryCode: row.countryCode ?? '',
        email: row.email ?? '',
        userId: row.userId ?? '',
      };
    } catch (err: any) {
      this.logger.error(`[TOKEN] Could not decrypt durable token for profile ${profileId} (wrong TOKEN_ENCRYPTION_KEY?): ${err.message}`);
      return null;
    }
  }
}
