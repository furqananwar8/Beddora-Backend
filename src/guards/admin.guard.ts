import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { SessionService } from 'src/modules/session/service/session.service';
import { ADMIN_EMAIL } from 'src/seeder/invited-user.seeder';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly sessionService: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const sessionId = req.cookies?.sid;

    if (!sessionId) {
      throw new ForbiddenException('No session');
    }

    // Get session from Redis via SessionService
    const session = await this.sessionService.get(sessionId);
    if (!session) {
      throw new ForbiddenException('Invalid session');
    }

    // Check if the logged-in user's email matches the admin email
    const userEmail = session.email;
    if (userEmail !== ADMIN_EMAIL) {
      throw new ForbiddenException('Only admin can invite users');
    }

    return true;
  }
}