import { Migration } from '@mikro-orm/migrations';

/**
 * Indexes for the scheduled-jobs listing (GET /campaigns/scheduled-jobs)
 * and the pending-job scans in the alert / expander services.
 *
 * Before this, schedule_job had only its primary key, so every page did a
 * full scan + sort, and `campaign_name ILIKE '%term%'` scanned every row.
 */
export class Migration20260928120000 extends Migration {

  override async up(): Promise<void> {
    // Default listing order + stable pagination tiebreaker.
    this.addSql(`create index if not exists "schedule_job_execute_at_id_index" on "schedule_job" ("execute_at", "id");`);
    // Status filter in the listing, and `status = 'pending' and execute_at <= / > now` scans.
    this.addSql(`create index if not exists "schedule_job_status_execute_at_index" on "schedule_job" ("status", "execute_at");`);
    // Per-campaign lookups.
    this.addSql(`create index if not exists "schedule_job_campaign_id_execute_at_index" on "schedule_job" ("campaign_id", "execute_at");`);
    // Substring search on campaign name (ILIKE '%term%') needs a trigram index.
    this.addSql(`create extension if not exists pg_trgm;`);
    this.addSql(`create index if not exists "schedule_job_campaign_name_trgm_index" on "schedule_job" using gin ("campaign_name" gin_trgm_ops);`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "schedule_job_campaign_name_trgm_index";`);
    this.addSql(`drop index if exists "schedule_job_campaign_id_execute_at_index";`);
    this.addSql(`drop index if exists "schedule_job_status_execute_at_index";`);
    this.addSql(`drop index if exists "schedule_job_execute_at_id_index";`);
  }

}
