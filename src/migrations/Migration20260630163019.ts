import { Migration } from '@mikro-orm/migrations';

export class Migration20260630163019 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "campaign_schedule" add column "campaign_name" varchar(255) null;`);

    this.addSql(`alter table "schedule_job" add column "bull_job_id" varchar(255) null, add column "campaign_name" varchar(255) null, add column "updated_at" timestamptz not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "campaign_schedule" drop column "campaign_name";`);

    this.addSql(`alter table "schedule_job" drop column "bull_job_id", drop column "campaign_name", drop column "updated_at";`);
  }

}
