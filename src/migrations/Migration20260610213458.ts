import { Migration } from '@mikro-orm/migrations';

export class Migration20260610213458 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "invited_user" ("id" serial primary key, "email" varchar(255) not null, "invited_by" varchar(255) null, "has_logged_in" boolean not null default false, "amazon_profile_id" int null, "name" varchar(255) null, "created_at" timestamptz null, "updated_at" timestamptz null);`);
    this.addSql(`alter table "invited_user" add constraint "invited_user_email_unique" unique ("email");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "invited_user" cascade;`);
  }

}
