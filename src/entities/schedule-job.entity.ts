import { Entity, PrimaryKey, Property, ManyToOne } from '@mikro-orm/core';
import { CampaignSchedule } from './campaign-schedule.entity';

@Entity()
export class ScheduleJob {
  @PrimaryKey()
  id!: number;

  @ManyToOne(() => CampaignSchedule, { deleteRule: 'cascade' })
  schedule?: CampaignSchedule;

  @Property()
  campaignId?: string;

  @Property({ type: 'bigint' })
  profileId!: number; // or number

  @Property()
  region?: string;

  @Property()
  executeAt?: Date;

  @Property()
  jobType?: 'slot_start' | 'slot_end';

  @Property()
  action?: 'ENABLE' | 'PAUSE';

  @Property({ default: 'pending' })
  status?: 'pending' | 'completed' | 'failed' | 'cancelled' = 'pending';

  @Property({ nullable: true })
  completedAt?: Date;

  @Property({ nullable: true })
  errorMessage?: string;

  @Property({ onCreate: () => new Date(), nullable: true })
  createdAt?: Date = new Date();
}