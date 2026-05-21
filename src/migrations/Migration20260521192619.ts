import { Migration } from '@mikro-orm/migrations';

export class Migration20260521192619 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "user" ("id" serial primary key, "amazon_user_id" varchar(255) not null, "name" varchar(255) not null, "last_login_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null);`);
    this.addSql(`alter table "user" add constraint "user_amazon_user_id_unique" unique ("amazon_user_id");`);
  }

}
