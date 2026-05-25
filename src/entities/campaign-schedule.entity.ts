import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { ScheduleAction, ScheduleStatus } from '../common/enum/campaign.enum';

@Entity()
export class CampaignSchedule {
  @PrimaryKey()
  id!: number;

  @Property()
  campaignId!: number;

  @Property()
  scheduleDate!: string;

  @Property({ nullable: true })
  endDate?: string;

  @Property({ type: 'json' })
  timeSlots!: Array<{ startTime: string; endTime: string }>;

  @Property()
  timezone!: string;

  @Property()
  action!: ScheduleAction;

  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  bidAdjustment?: number;

  @Property()
  status!: ScheduleStatus;

  @Property({ onCreate: () => new Date(), defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date(), defaultRaw: 'now()' })
  updatedAt!: Date;
}