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
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly isProd: boolean = false;
  constructor(
    private em: EntityManager, 
    private authService: AuthService, 
    private sessionService: SessionService,
    @InjectQueue(AMAZON_TOKEN_REFRESH) private readonly tokenRefreshQueue: Queue,
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
    const existingSessionId = req.cookies?.[SESSION_COOKIE];
    const state = crypto.randomUUID();
    let sessionId = existingSessionId;

    // If we have an existing cookie, try to update Redis
    if (existingSessionId) {
      const updated = await this.sessionService.update(
        existingSessionId,
        { oauthState: state },
        300,
      );

      // Redis doesn't have this session — cookie is stale
      if (!updated) {
        // Clear the bad cookie immediately
        res.clearCookie(SESSION_COOKIE, {
          path: '/',
          sameSite: this.isProd ? 'none' : 'lax',
          secure: this.isProd,
          httpOnly: true,
        });
        sessionId = null; // Force new session creation below
      }
    }

    // No valid session — create a new one
    if (!sessionId) {
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
        300,
      );

     

      res.cookie(SESSION_COOKIE, newSessionId, {
        httpOnly: true,
        sameSite: this.isProd ? 'none' : 'lax',
        secure: this.isProd,
        path: '/',
        maxAge: 300 * 1000,
      });

      sessionId = newSessionId;
    }

    const params = new URLSearchParams({
      client_id: this.configService.getOrThrow('AMAZON_CLIENT_ID'),
      response_type: 'code',
      redirect_uri: this.configService.getOrThrow('AMAZON_REDIRECT_URI'),
      scope: 'profile advertising::campaign_management',
      state,
    });

    return { url: `https://www.amazon.com/ap/oa?${params.toString()}` };
  }

  @Get('amazon/callback')
  async amazonCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (error) throw new BadRequestException(`Amazon OAuth error: ${error}`);
    if (!code) throw new BadRequestException('Missing authorization code');

    const sessionId = req.cookies?.[SESSION_COOKIE];
    if (!sessionId) throw new UnauthorizedException('No session found');

    const session = await this.sessionService.get(sessionId);
    if (!session) throw new UnauthorizedException('Session expired');
    if (state !== session.oauthState) throw new UnauthorizedException('Invalid OAuth state');

    // Exchange code
    const { sessionId: finalSessionId, expiresIn, access_token } = await this.authService.exchangeCodeForTokens(code, sessionId);
    // Fetch Amazon Advertising profiles and attach to session
    let profileId: number | undefined;
    let region: 'na' | 'eu' | 'fe' = 'na';
    let countryCode: string | undefined;

    try {
      const clientId = this.configService.getOrThrow('AMAZON_CLIENT_ID');

      const { data: profiles } = await firstValueFrom(
        this.httpService.get<Array<{
          profileId: number;
          countryCode: string;
          currencyCode: string;
          timezone: string;
        }>>('https://advertising-api.amazon.com/profiles', {
          headers: { Authorization: `Bearer ${access_token}`, 'Amazon-Advertising-API-ClientId': clientId },
        }),
      );


      if (profiles?.length > 0) {
        const naCountries = ['US', 'CA', 'MX', 'BR'];
        const euCountries = ['GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'AE', 'SA', 'SE', 'PL', 'TR', 'BE', 'EG'];
        const feCountries = ['JP', 'AU', 'IN', 'SG'];

        const mappedProfiles = profiles.map((p) => {
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

        // Save ALL profiles to session
        await this.sessionService.update(finalSessionId, {
          profiles: mappedProfiles,
          profileId: mappedProfiles[0].profileId,
          region: mappedProfiles[0].region,
          countryCode: mappedProfiles[0].countryCode,
        }, expiresIn - 60);
      }
    } catch (e: any) {
      // Log the FULL error so you know if it's 401, 403, or 404
      if (e.response) {
        console.error(`[Amazon API Error] ${e.response.status} ${e.config?.url}`);
        console.error(`[Amazon API Error Body]`, JSON.stringify(e.response.data, null, 2));
      } else {
        console.error(`[Amazon API Error]`, e.message);
      }
      
      // Hard fail — a session without profileId is useless for campaigns
      throw new BadRequestException(
        `Failed to link Amazon Advertising profile: ${e.response?.data?.details || e.message}`
      );
    }

    res.cookie(SESSION_COOKIE, finalSessionId, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: (expiresIn - 60) * 1000,
      path: '/',
    });

    this.tokenRefreshQueue.add(
      'refresh',
      { sessionId: finalSessionId },
      { delay: REFRESH_JOB_DELAY_MS },
    );

    return res.json({
      success: true,
      sessionId: finalSessionId,
      profileId: profileId ?? null,
      region: profileId ? region : null,
    });
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