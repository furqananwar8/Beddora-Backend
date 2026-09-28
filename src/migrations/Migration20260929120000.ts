import { Migration } from '@mikro-orm/migrations';

/**
 * 1. amazon_profile_token: durable (encrypted) fallback for the Amazon
 *    refresh token, used when the Redis key is missing after an outage.
 * 2. Unique (schedule_id, job_type, execute_at) on schedule_job so creating
 *    the next occurrence is idempotent. Existing duplicates are removed first,
 *    keeping the most-progressed row (completed > processing > pending > other).
 */
export class Migration20260929120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "amazon_profile_token" (
      "id" serial primary key,
      "profile_id" bigint not null,
      "refresh_token_encrypted" text not null,
      "region" varchar(255) null,
      "country_code" varchar(255) null,
      "email" varchar(255) null,
      "user_id" varchar(255) null,
      "created_at" timestamptz not null,
      "updated_at" timestamptz not null
    );`);
    this.addSql(`create unique index if not exists "amazon_profile_token_profile_id_unique" on "amazon_profile_token" ("profile_id");`);

    this.addSql(`
      delete from "schedule_job" j
      using (
        select id, row_number() over (
          partition by schedule_id, job_type, execute_at
          order by case status
            when 'completed' then 0 when 'processing' then 1 when 'pending' then 2 else 3 end, id
        ) as rn
        from "schedule_job"
      ) d
      where j.id = d.id and d.rn > 1;`);
    this.addSql(`create unique index if not exists "schedule_job_schedule_type_execute_at_unique" on "schedule_job" ("schedule_id", "job_type", "execute_at");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "schedule_job_schedule_type_execute_at_unique";`);
    this.addSql(`drop table if exists "amazon_profile_token" cascade;`);
  }

}
