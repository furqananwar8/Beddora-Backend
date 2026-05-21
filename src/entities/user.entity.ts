import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity()
export class User {
  @PrimaryKey()
  id?: number;

  @Property({ unique: true })
  amazonUserId?: string;

  @Property()
  name?: string;

  @Property({ nullable: true })
  lastLoginAt?: Date;

  @Property({ onCreate: () => new Date() })
  createdAt?: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt?: Date;
}