import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity()
export class InvitedUser {
  @PrimaryKey()
  id!: number;

  @Property({ unique: true })
  email!: string;

  @Property({ nullable: true })
  invitedBy?: string;

  @Property({ default: false })
  hasLoggedIn?: boolean = false;

  @Property({ nullable: true })
  amazonProfileId?: number;

  @Property({ nullable: true })
  name?: string;

  @Property({ onCreate: () => new Date(), nullable: true })
  createdAt?: Date = new Date();

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date(), nullable: true })
  updatedAt?: Date = new Date();

}