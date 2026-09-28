import { Migration } from '@mikro-orm/migrations';

/**
 * Backfills columns that exist on the entities but were never captured in a
 * migration (fresh databases booted without them). `if not exists` keeps this
 * a no-op on databases where they were added manually / via schema:update.
 */
export class Migration20260928180000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "schedule_job" add column if not exists "redis_alert_sent_at" timestamptz null;`);

    this.addSql(`alter table "user" add column if not exists "email" varchar(255) not null;`);
    this.addSql(`create unique index if not exists "user_email_unique" on "user" ("email");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "user_email_unique";`);
    this.addSql(`alter table "user" drop column if exists "email";`);
    this.addSql(`alter table "schedule_job" drop column if exists "redis_alert_sent_at";`);
  }

}
