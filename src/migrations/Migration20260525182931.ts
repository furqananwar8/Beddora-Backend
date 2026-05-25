import { Migration } from '@mikro-orm/migrations';

export class Migration20260525182931 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "campaign_schedule" ("id" serial primary key, "campaign_id" int not null, "schedule_date" varchar(255) not null, "end_date" varchar(255) null, "time_slots" jsonb not null, "timezone" varchar(255) not null, "action" varchar(255) not null, "bid_adjustment" numeric(10,2) null, "status" varchar(255) not null, "created_at" timestamptz not null, "updated_at" timestamptz not null);`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "campaign_schedule" cascade;`);
  }

}
