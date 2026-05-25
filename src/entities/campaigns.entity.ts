import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity()
export class Campaign {
  @PrimaryKey()
  campaignId!: number;

  @Property()
  name!: string;

  @Property()
  campaignType!: string;

  @Property()
  targetingType!: string;

  @Property()
  state!: string;

  @Property({ type: 'decimal', precision: 10, scale: 2 })
  dailyBudget!: number;

  @Property()
  startDate!: string;

  @Property({ nullable: true })
  endDate?: string;

  @Property({ default: false })
  premiumBidAdjustment!: boolean;

  @Property({ type: 'json', nullable: true })
  bidding?: any;

  @Property()
  profileId!: number;

  @Property()
  lastSyncedAt!: Date;
}