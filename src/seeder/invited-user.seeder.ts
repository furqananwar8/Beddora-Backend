import { EntityManager } from '@mikro-orm/core';
import { InvitedUser } from 'src/entities/invited-user';


export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "khanjan@beddora.ca"; // ← change to your admin email

export async function seedAdminUser(em: EntityManager): Promise<void> {
  const exists = await em.findOne(InvitedUser, { email: ADMIN_EMAIL });
  if (!exists) {
    em.create(InvitedUser, {
      email: ADMIN_EMAIL,
      invitedBy: 'system',
      hasLoggedIn: true,
    });
    
    await em.flush();
    console.log(`[SEEDER] Created admin invite record for ${ADMIN_EMAIL}`);
  } else {
    console.log(`[SEEDER] Admin invite record already exists for ${ADMIN_EMAIL}`);
  }
}