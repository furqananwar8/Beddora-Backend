import {
  Controller,
  Get,
  Query,
  Res,
  Req,
  Post,
  BadRequestException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiCookieAuth } from '@nestjs/swagger';
import { AuthService } from '../service/auth.service';
import { SessionService } from 'src/modules/session/service/session.service';
import { EntityManager } from '@mikro-orm/core';
import { User } from 'src/entities/user.entity';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AMAZON_TOKEN_REFRESH, REFRESH_JOB_DELAY_MS } from 'src/common/constants/bullmq.constant';
import { ConfigService } from '@nestjs/config';
import { SessionAuthGuard } from 'src/guards/SessionAuth.guard';
import { SESSION_COOKIE } from 'src/common/constants/session.constant';
import { randomBytes } from 'crypto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private em: EntityManager, 
    private authService: AuthService, 
    private sessionService: SessionService,
    @InjectQueue(AMAZON_TOKEN_REFRESH) private readonly tokenRefreshQueue: Queue,
    private readonly configService: ConfigService
  ) {}
  
  @Get('amazon/login')
  @ApiOperation({ summary: 'Initiate Amazon OAuth login' })
  @ApiCookieAuth('sid')
  @ApiResponse({ status: 200, description: 'Amazon OAuth URL', schema: { example: { url: 'https://www.amazon.com/ap/oa?...' } } })
  async amazonLogin(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const existingSessionId = req.cookies?.[SESSION_COOKIE];
    const state = crypto.randomUUID();

    if (existingSessionId) {
      await this.sessionService.update(existingSessionId, { oauthState: state }, 300);
    } else {
        // Create new session — generate ID here to match your signature
        const newSessionId = randomBytes(32).toString('base64url');
        await this.sessionService.create(
          newSessionId,
          {
            oauthState: state,
            userId: '',
            access_token: '',
            refresh_token: '',
            token_type: '',
            expires_at: 0,
          },
          300, // 5 min TTL for OAuth state
        );
        
        // Set the session cookie so the callback can read it
        res.cookie(SESSION_COOKIE, newSessionId, {
          httpOnly: true,
          sameSite: 'none',
          secure: true,
          path: '/',
          maxAge: 300 * 1000,
        });
    }

    const params = new URLSearchParams({
      client_id: this.configService.getOrThrow('AMAZON_CLIENT_ID'),
      response_type: 'code',
      redirect_uri: this.configService.getOrThrow('AMAZON_REDIRECT_URI'),
      scope: 'profile',
      state,
    });

    return { url: `https://www.amazon.com/ap/oa?${params.toString()}` };
  }

  @Get('amazon/callback')
  @ApiOperation({
    summary: 'Amazon OAuth callback',
    description: 'Verifies OAuth state, exchanges code for tokens via AuthService, updates session cookie, and redirects to frontend.',
  })
  @ApiQuery({ name: 'code', required: false, description: 'Authorization code from Amazon' })
  @ApiQuery({ name: 'state', required: false, description: 'OAuth state for CSRF protection' })
  @ApiQuery({ name: 'error', required: false, description: 'Error if user denied access' })
  @ApiCookieAuth('sid')
  @ApiResponse({ status: 302, description: 'Redirects to frontend dashboard' })
  @ApiResponse({ status: 400, description: 'Missing code or Amazon error' })
  @ApiResponse({ status: 401, description: 'No session, expired session, or invalid state' })
  async amazonCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) {
      throw new BadRequestException(`Amazon OAuth error: ${error}`);
    }
    if (!code) {
      throw new BadRequestException('Missing authorization code');
    }

    // Verify state against the session created in /amazon/login
    const sessionId = req.cookies?.[SESSION_COOKIE];
    if (!sessionId) {
      throw new UnauthorizedException('No session found');
    }

    const session = await this.sessionService.get(sessionId);
    if (!session) {
      throw new UnauthorizedException('Session expired');
    }
    if (state !== session.oauthState) {
      throw new UnauthorizedException('Invalid OAuth state');
    }

    // Service handles token exchange, profile, user upsert, and session update
    const { sessionId: finalSessionId, expiresIn } = await this.authService.exchangeCodeForTokens(
      code,
      sessionId, // pass existing session so it updates instead of creating new
    );
    // Refresh cookie TTL to match token expiry
    res.cookie(SESSION_COOKIE, finalSessionId, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: (expiresIn - 60) * 1000,
      path: '/',
    });

    this.tokenRefreshQueue.add(
      'refresh',
      { sessionId },
      { delay: REFRESH_JOB_DELAY_MS },
    );

    return res.json({ success: true, sessionId: finalSessionId });
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({
    summary: 'Validate current session',
    description: 'Reads the sid cookie, checks session validity in Redis, and auto-refreshes the Amazon token if expiring soon.',
  })
  @ApiResponse({ status: 200, description: 'Session is valid', schema: { example: { authenticated: true } } })
  @ApiResponse({ status: 401, description: 'No session cookie or session expired' })
  async getSession(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.cookies?.[SESSION_COOKIE];
    if (!sessionId) throw new UnauthorizedException('No session found');

    const session = await this.sessionService.get(sessionId);
    if (!session) throw new UnauthorizedException('Session expired');

    const user = await this.em.findOne(User, { id: parseInt(session.userId) });
    const finalUserOutput = {...user};
    delete finalUserOutput.amazonUserId;
    
    if (!user) {
      await this.sessionService.delete(sessionId);
      res.clearCookie(SESSION_COOKIE);
      throw new UnauthorizedException('User not found');
    }

    return res.status(200).json({ message: "Profile retrieved successfully", user: finalUserOutput });
  }

  @Post('logout')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({
    summary: 'Logout',
    description: 'Destroys the server-side session in Redis and clears the sid cookie.',
  })
  @ApiResponse({ status: 200, description: 'Logged out successfully', schema: { example: { success: true } } })
  async logout(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.cookies?.[SESSION_COOKIE];

    if (sessionId) {
      await this.authService.logout(sessionId);
    }

    res.clearCookie(SESSION_COOKIE);
    return res.status(200).json({ message: 'Logged user out successfully' });
  }
}