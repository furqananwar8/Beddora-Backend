import { Migration } from '@mikro-orm/migrations';

export class Migration20260525180555 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "amazon_campaign" ("campaign_id" serial primary key, "name" varchar(255) not null, "campaign_type" varchar(255) not null, "targeting_type" varchar(255) not null, "state" varchar(255) not null, "daily_budget" numeric(10,2) not null, "start_date" varchar(255) not null, "end_date" varchar(255) null, "premium_bid_adjustment" boolean not null default false, "bidding" jsonb null, "tags" jsonb null, "profile_id" int not null);`);

    this.addSql(`create table "campaign" ("campaign_id" serial primary key, "name" varchar(255) not null, "campaign_type" varchar(255) not null, "targeting_type" varchar(255) not null, "state" varchar(255) not null, "daily_budget" numeric(10,2) not null, "start_date" varchar(255) not null, "end_date" varchar(255) null, "premium_bid_adjustment" boolean not null default false, "bidding" jsonb null, "profile_id" int not null, "last_synced_at" timestamptz not null);`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "amazon_campaign" cascade;`);

    this.addSql(`drop table if exists "campaign" cascade;`);
  }

}
