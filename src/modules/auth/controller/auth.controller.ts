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
  ForbiddenException,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiCookieAuth } from '@nestjs/swagger';
import { AuthService } from '../service/auth.service';
import { SessionService } from 'src/modules/session/service/session.service';
import { ProfileTokenService } from 'src/modules/session/service/profile-token.service';
import { EntityManager } from '@mikro-orm/core';
import { User } from 'src/entities/user.entity';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AMAZON_PROFILE_TOKEN_REFRESH, AMAZON_TOKEN_REFRESH, REFRESH_JOB_DELAY_MS } from 'src/common/constants/bullmq.constant';
import { ConfigService } from '@nestjs/config';
import { SessionAuthGuard } from 'src/guards/SessionAuth.guard';
import { EXPIRES_IN_30DAYS, EXPIRES_IN_30MIN, SESSION_COOKIE } from 'src/common/constants/session.constant';
import { randomBytes } from 'crypto';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { InvitedUser } from 'src/entities/invited-user.entity';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly isProd: boolean = false;
  constructor(
    private em: EntityManager,
    private authService: AuthService,
    private sessionService: SessionService,
    private profileTokenService: ProfileTokenService,
    @InjectQueue(AMAZON_TOKEN_REFRESH) private readonly tokenRefreshQueue: Queue,
    @InjectQueue(AMAZON_PROFILE_TOKEN_REFRESH) private readonly profileTokenRefreshQueue: Queue,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.isProd = process.env.NODE_ENV === 'production';
  }

  @Get('amazon/login')
  @ApiOperation({ summary: 'Initiate Amazon OAuth login' })
  @ApiCookieAuth('sid')
  @ApiResponse({ status: 200, description: 'Amazon OAuth URL' })
  async amazonLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const state = crypto.randomUUID();
    const existingSessionId = req.cookies?.[SESSION_COOKIE];

    if (existingSessionId) {
      await this.sessionService.delete(existingSessionId);
      res.clearCookie(SESSION_COOKIE, {
        path: '/',
        sameSite: this.isProd ? 'none' : 'lax',
        secure: this.isProd,
        httpOnly: true,
      });
    }

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
      EXPIRES_IN_30MIN,
    );

    const encodedState = Buffer.from(JSON.stringify({ state, sessionId: newSessionId })).toString('base64url');

    res.cookie(SESSION_COOKIE, newSessionId, {
      httpOnly: true,
      sameSite: this.isProd ? 'none' : 'lax',
      secure: this.isProd,
      path: '/',
      maxAge: EXPIRES_IN_30MIN * 1000,
    });

    const params = new URLSearchParams({
      client_id: this.configService.getOrThrow('AMAZON_CLIENT_ID'),
      response_type: 'code',
      redirect_uri: this.configService.getOrThrow('AMAZON_REDIRECT_URI'),
      scope: 'profile advertising::campaign_management',
      state: encodedState,
    });

    return { url: `https://www.amazon.com/ap/oa?${params.toString()}` };
  }

  @Get('amazon/callback')
  async amazonCallback(
    @Query('code') code: string,
    @Query('state') encodedState: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) throw new BadRequestException(`Amazon OAuth error: ${error}`);
    if (!code) throw new BadRequestException('Missing authorization code');

    let state: string;
    let sessionId: string;
    let mappedProfiles: any;
    try {
      const decoded = JSON.parse(Buffer.from(encodedState, 'base64url').toString());
      state = decoded.state;
      sessionId = decoded.sessionId;
    } catch {
      throw new UnauthorizedException('Invalid state parameter');
    }

    if (!sessionId) throw new UnauthorizedException('No session found in state');

    const session = await this.sessionService.get(sessionId);
    if (!session) throw new UnauthorizedException('Session expired');
    if (state !== session.oauthState) throw new UnauthorizedException('Invalid OAuth state');

    const {
      sessionId: finalSessionId,
      expiresIn,
      access_token,
      refresh_token,
      email: amazonEmail,
    } = await this.authService.exchangeCodeForTokens(code, sessionId);

    try {
      const clientId = this.configService.getOrThrow('AMAZON_CLIENT_ID');

      const { data: profiles } = await firstValueFrom(
        this.httpService.get<Array<{
          profileId: number;
          countryCode: string;
          currencyCode: string;
          timezone: string;
        }>>('https://advertising-api.amazon.com/profiles', {
          headers: {
            Authorization: `Bearer ${access_token}`,
            'Amazon-Advertising-API-ClientId': clientId,
          },
        }),
      );

      if (profiles?.length > 0) {
        const naCountries = ['US', 'CA', 'MX', 'BR'];
        const euCountries = ['GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'AE', 'SA', 'SE', 'PL', 'TR', 'BE', 'EG'];
        const feCountries = ['JP', 'AU', 'IN', 'SG'];

        mappedProfiles = profiles.map((p) => {
          let region: 'na' | 'eu' | 'fe' = 'na';
          if (euCountries.includes(p.countryCode)) region = 'eu';
          else if (feCountries.includes(p.countryCode)) region = 'fe';
          else if (naCountries.includes(p.countryCode)) region = 'na';
          else region = 'na';

          return {
            profileId: p.profileId,
            countryCode: p.countryCode,
            region,
          };
        });

        await this.sessionService.update(
          finalSessionId,
          {
            token_type: 'bearer',
            expires_at: Date.now() + (expiresIn * 1000),
            profiles: mappedProfiles,
            profileId: mappedProfiles[0].profileId,
            region: mappedProfiles[0].region,
            countryCode: mappedProfiles[0].countryCode,
            email: amazonEmail,
          },
          expiresIn - 60,
        );

        const user = await this.em.findOne(User, { email: amazonEmail });
        await this.profileTokenService.create(
          mappedProfiles[0].profileId,
          {
            access_token,
            refresh_token,
            expires_at: Date.now() + expiresIn * 1000,
            region: mappedProfiles[0].region,
            countryCode: mappedProfiles[0].countryCode,
            email: amazonEmail,
            userId: String(user?.id ?? ''),
          },
          expiresIn - 60,
        );

        await this.tokenRefreshQueue.add(
          'refresh-service',
          { profileId: mappedProfiles[0].profileId },
          { delay: REFRESH_JOB_DELAY_MS, attempts: 3, removeOnFail: { count: 5 }, removeOnComplete: { count: 10 } },
        );
      }
    } catch (e: any) {
      return res.status(200).json({
        success: false,
        error: e.response?.error || 'UNKNOWN_ERROR',
        message: e.message,
      });
    }

    res.cookie(SESSION_COOKIE, finalSessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isProd,
      maxAge: EXPIRES_IN_30DAYS,
      path: '/',
    });

    // Browser session refresh chain (dies on logout)
    await this.tokenRefreshQueue.add('refresh', { sessionId: finalSessionId }, {
      delay: REFRESH_JOB_DELAY_MS,
    });

    // Profile token refresh chain (survives logout)
    await this.profileTokenRefreshQueue.add('refresh-service', { profileId: mappedProfiles[0].profileId }, {
      delay: REFRESH_JOB_DELAY_MS,
      attempts: 3,
      removeOnFail: { count: 5 },
      removeOnComplete: { count: 10 },
    });

    return res.json({
      success: true,
      sessionId: finalSessionId,
      profileId: null,
      region: null,
    });
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({ summary: 'Validate current session' })
  @ApiResponse({ status: 200, description: 'Session is valid' })
  @ApiResponse({ status: 401, description: 'No session cookie or session expired' })
  async getSession(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.cookies?.[SESSION_COOKIE];
    if (!sessionId) throw new UnauthorizedException('No session found');

    const session = await this.sessionService.get(sessionId);
    if (!session) throw new UnauthorizedException('Session expired');

    const user = await this.em.findOne(User, { id: parseInt(session.userId) });
    if (!user) {
      await this.sessionService.delete(sessionId);
      res.clearCookie(SESSION_COOKIE);
      throw new UnauthorizedException('User not found');
    }

    const finalUserOutput = { ...user };
    delete (finalUserOutput as any).amazonUserId;

    const invitedRecord = await this.em.findOne(InvitedUser, {
      email: session.email?.toLowerCase(),
    });

    return res.status(200).json({
      message: 'Profile retrieved successfully',
      user: finalUserOutput,
      invitedBy: invitedRecord?.invitedBy ?? null,
    });
  }

  @Post('logout')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({ summary: 'Logout' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.cookies?.[SESSION_COOKIE];

    if (sessionId) {
      await this.authService.logout(sessionId);
    }

    res.clearCookie(SESSION_COOKIE);
    return res.status(200).json({ message: 'Logged user out successfully' });
  }

  @Post('disconnect-amazon')
  @UseGuards(SessionAuthGuard)
  @ApiOperation({ summary: 'Disconnect Amazon and cancel all scheduled jobs' })
  async disconnectAmazon(@Req() req: Request) {
    const sessionId = req.cookies?.[SESSION_COOKIE];
    const session = await this.sessionService.get(sessionId);
    if (!session?.profileId) {
      throw new UnauthorizedException('No session found');
    }

    await this.profileTokenService.delete(session.profileId);
    return { message: 'Amazon disconnected. Background scheduling stopped.' };
  }
}