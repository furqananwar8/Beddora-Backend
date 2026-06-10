import { Entity, PrimaryKey, Property, OneToMany, Collection } from '@mikro-orm/core';
import { ScheduleJob } from './schedule-job.entity';

@Entity()
export class CampaignSchedule {
  @PrimaryKey()
  id!: number;

  @Property()
  campaignId!: string;

  @Property({ type: 'bigint' })
  profileId!: number;

  @Property()
  region?: string;

  @Property()
  sessionId?: string;

  @Property()
  dayOfWeek!: number;

  @Property({ type: 'json' })
  timeSlots?: Array<{ startTime: string; endTime: string }>;

  @Property()
  action?: 'ENABLED' | 'PAUSED';

  @Property({ default: true })
  isActive?: boolean = true;

  @OneToMany(() => ScheduleJob, (job) => job.schedule)
  jobs = new Collection<ScheduleJob>(this);

  @Property({ onCreate: () => new Date(), nullable: true })
  createdAt?: Date = new Date();

  @Property({ onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date = new Date();
}