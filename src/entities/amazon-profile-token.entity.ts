import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

/**
 * Durable fallback for the Amazon refresh token. Redis
 * (profile-token-beddora:<profileId>) is the primary store; this row is only
 * read when the Redis key is missing, so scheduled jobs can re-mint an access
 * token after an outage instead of failing until someone logs in again.
 */
@Entity()
export class AmazonProfileToken {
  @PrimaryKey()
  id!: number;

  @Unique()
  @Property({ type: 'bigint' })
  profileId!: number;

  /** AES-256-GCM encrypted, see token-crypto.ts */
  @Property({ type: 'text' })
  refreshTokenEncrypted!: string;

  @Property({ nullable: true })
  region?: string;

  @Property({ nullable: true })
  countryCode?: string;

  @Property({ nullable: true })
  email?: string;

  @Property({ nullable: true })
  userId?: string;

  @Property({ onCreate: () => new Date() })
  createdAt?: Date = new Date();

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt?: Date = new Date();
}
