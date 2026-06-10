import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { ADMIN_EMAIL } from 'src/seeder/invited-user.seeder';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly em: EntityManager) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const sessionId = req.cookies?.sid;

    if (!sessionId) {
      throw new ForbiddenException('No session');
    }

    // Get session from your session service
    const session = await this.em.findOne('Session', { id: sessionId } as any);
    if (!session) {
      throw new ForbiddenException('Invalid session');
    }

    // Check if the logged-in user's email matches the admin email
    // You need to store email in session during OAuth callback
    const userEmail = (session as any).email;
    if (userEmail !== ADMIN_EMAIL) {
      throw new ForbiddenException('Only admin can invite users');
    }

    return true;
  }
}