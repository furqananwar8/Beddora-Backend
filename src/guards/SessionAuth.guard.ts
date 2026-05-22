// guards/session-auth.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { SESSION_COOKIE, SESSION_EXPIRED, SESSION_INVALID, SESSION_NOT_FOUND } from 'src/common/constants/session.constant';
import { SessionService } from 'src/modules/session/service/session.service'; // adjust path

export interface SessionData {
  access_token: string;
  userId: string;
  refresh_token: string;
  token_type: string;
  expires_at: number; // unix timestamp ms
  user_id?: string;     // Amazon user ID
  oauthState?: string;
}

export interface AuthenticatedRequest extends Request {
  session?: SessionData & { [key: string]: any };
  user?: {
    userId: string;
    amazonUserId?: string;
    accessToken: string;
    tokenType: string;
  };
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly sessionService: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // 1. Extract session ID from cookie
    const sessionId = request.cookies?.[SESSION_COOKIE];
    if (!sessionId || typeof sessionId !== 'string') {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'No active session found.',
        error: SESSION_NOT_FOUND,
      });
    }

    // 2. Fetch session data from service/storage
    const session = await this.sessionService.get(sessionId); // <-- use your actual method name
    if (!session) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Session not found or has been invalidated.',
        error: SESSION_INVALID,
      });
    }

    // 3. Validate required fields
    if (!session.access_token || typeof session.access_token !== 'string' || session.access_token.trim() === '') {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Session is missing a valid access token.',
        error: SESSION_INVALID,
      });
    }

    if (!session.userId || typeof session.userId !== 'string' || session.userId.trim() === '') {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Session is missing user identification.',
        error: SESSION_INVALID,
      });
    }

    // 4. Check expiration
    const now = Date.now();
    if (typeof session.expires_at !== 'number' || session.expires_at <= now) {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Access token has expired. Please re-authenticate.',
        error: SESSION_EXPIRED,
      });
    }

    // 5. Optional: require refresh token
    if (!session.refresh_token || typeof session.refresh_token !== 'string') {
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Session is missing refresh credentials.',
        error: SESSION_INVALID,
      });
    }

    // 6. Attach to request for downstream use
    request.session = session;
    request.user = {
      userId: session.userId,
      amazonUserId: session.user_id,
      accessToken: session.access_token,
      tokenType: session.token_type || 'Bearer',
    };

    return true;
  }
}