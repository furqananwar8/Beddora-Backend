import { Entity, Index, PrimaryKey, Property, ManyToOne, Unique } from '@mikro-orm/core';
import { CampaignSchedule } from './campaign-schedule.entity';

@Entity()
// One job per slot occurrence: makes next-week creation idempotent across
// retries, restarts and the chain reconciler.
@Unique({ name: 'schedule_job_schedule_type_execute_at_unique', properties: ['schedule', 'jobType', 'executeAt'] })
@Index({ name: 'schedule_job_execute_at_id_index', properties: ['executeAt', 'id'] })
@Index({ name: 'schedule_job_status_execute_at_index', properties: ['status', 'executeAt'] })
@Index({ name: 'schedule_job_campaign_id_execute_at_index', properties: ['campaignId', 'executeAt'] })
@Index({
  name: 'schedule_job_campaign_name_trgm_index',
  expression:
    'create index "schedule_job_campaign_name_trgm_index" on "schedule_job" using gin ("campaign_name" gin_trgm_ops)',
})
export class ScheduleJob {
  @PrimaryKey()
  id!: number;

  @ManyToOne(() => CampaignSchedule, { deleteRule: 'cascade' })
  schedule?: CampaignSchedule;

  @Property()
  campaignId?: string;

  @Property({ type: 'bigint' })
  profileId!: number; // or number

  @Property({ nullable: true })
  bullJobId?: string | null = null; 

  @Property({ nullable: true, type: 'datetime' })
  redisAlertSentAt?: Date | null;

  @Property()
  region?: string;

  @Property()
  executeAt?: Date;

  @Property()
  jobType?: 'slot_start' | 'slot_end';

  @Property({ nullable: true })
  campaignName?: string;

  @Property()
  action?: 'ENABLE' | 'PAUSE';

  @Property({ default: 'pending' })
  status?: 'pending' | 'completed' | 'failed' | 'cancelled' | 'processing' | 'expired' | 'deleted' | 'archived'= 'pending';

  @Property({ nullable: true })
  completedAt?: Date;

  @Property({ nullable: true })
  errorMessage?: string | null;

  @Property({ onCreate: () => new Date(), nullable: true })
  createdAt?: Date = new Date();

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt?: Date = new Date();
}