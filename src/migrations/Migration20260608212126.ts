import { Migration } from '@mikro-orm/migrations';

export class Migration20260608212126 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "campaign_schedule" alter column "profile_id" type bigint using ("profile_id"::bigint);`);

    this.addSql(`alter table "schedule_job" alter column "profile_id" type bigint using ("profile_id"::bigint);`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "campaign_schedule" alter column "profile_id" type int4 using ("profile_id"::int4);`);

    this.addSql(`alter table "schedule_job" alter column "profile_id" type int4 using ("profile_id"::int4);`);
  }

}
