// // src/entities/scheduler-rule.entity.ts
// import { Entity, PrimaryKey, Property, ManyToOne } from '@mikro-orm/core';
// import { Campaign } from './campaign.entity';

// @Entity()
// export class SchedulerRule {
//   @PrimaryKey()
//   id!: number;

//   @ManyToOne(() => Campaign)
//   campaign!: Campaign;

//   @Property()
//   dayOfWeek!: number; // 0=Sunday, 1=Monday, etc.

//   @Property()
//   startMinute!: number; // 0-1439 (e.g., 540 = 9:00 AM)

//   @Property()
//   endMinute!: number; // 0-1439

//   @Property()
//   action!: 'enable' | 'pause';

//   @Property({ default: true })
//   isActive: boolean = true;

//   @Property()
//   createdAt: Date = new Date();
// }