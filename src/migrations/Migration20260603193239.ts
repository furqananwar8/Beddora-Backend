import { Migration } from '@mikro-orm/migrations';

export class Migration20260603193239 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "amazon_campaign" ("campaign_id" serial primary key, "name" varchar(255) not null, "campaign_type" varchar(255) not null, "targeting_type" varchar(255) not null, "state" varchar(255) not null, "daily_budget" numeric(10,2) not null, "start_date" varchar(255) not null, "end_date" varchar(255) null, "premium_bid_adjustment" boolean not null default false, "bidding" jsonb null, "tags" jsonb null, "profile_id" int not null);`);

    this.addSql(`create table "campaign" ("campaign_id" serial primary key, "name" varchar(255) not null, "campaign_type" varchar(255) not null, "targeting_type" varchar(255) not null, "state" varchar(255) not null, "daily_budget" numeric(10,2) not null, "start_date" varchar(255) not null, "end_date" varchar(255) null, "premium_bid_adjustment" boolean not null default false, "bidding" jsonb null, "profile_id" int not null, "last_synced_at" timestamptz not null);`);

    this.addSql(`create table "campaign_schedule" ("id" serial primary key, "campaign_id" varchar(255) not null, "profile_id" int not null, "region" varchar(255) not null, "session_id" varchar(255) not null, "schedule_date" varchar(255) not null, "end_date" varchar(255) null, "time_slots" jsonb not null, "action" varchar(255) not null, "is_active" boolean not null default true, "created_at" timestamptz null, "updated_at" timestamptz null);`);

    this.addSql(`create table "schedule_job" ("id" serial primary key, "schedule_id" int not null, "campaign_id" varchar(255) not null, "profile_id" int not null, "region" varchar(255) not null, "execute_at" timestamptz not null, "job_type" varchar(255) not null, "action" varchar(255) not null, "status" varchar(255) not null default 'pending', "completed_at" timestamptz null, "error_message" varchar(255) null, "created_at" timestamptz null);`);

    this.addSql(`create table "user" ("id" serial primary key, "amazon_user_id" varchar(255) not null, "name" varchar(255) not null, "last_login_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null);`);
    this.addSql(`alter table "user" add constraint "user_amazon_user_id_unique" unique ("amazon_user_id");`);

    this.addSql(`alter table "schedule_job" add constraint "schedule_job_schedule_id_foreign" foreign key ("schedule_id") references "campaign_schedule" ("id") on update cascade on delete cascade;`);
  }

}
