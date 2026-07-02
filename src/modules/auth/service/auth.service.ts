import { EntityManager } from '@mikro-orm/core';
import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { InvitedUser } from 'src/entities/invited-user.entity';
import { User } from 'src/entities/user.entity';
import { SessionData, SessionService } from 'src/modules/session/service/session.service';

interface AmazonTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  error?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private config: ConfigService,
    private sessionService: SessionService,
    private em: EntityManager
  ) {}

  async exchangeCodeForTokens(
    code: string,
    existingSessionId: string,
  ): Promise<{
    sessionId: string;
    expiresIn: number;
    access_token: string;
    refresh_token: string;
    email: string;
    name: string;
  }> {
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.getOrThrow('AMAZON_CLIENT_ID'),
        client_secret: this.config.getOrThrow('AMAZON_CLIENT_SECRET'),
        redirect_uri: this.config.getOrThrow('AMAZON_REDIRECT_URI'),
      }),
    });

    const tokenData: AmazonTokenResponse = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      throw new UnauthorizedException(`Amazon token exchange failed: ${tokenData.error}`);
    }

    const profileRes = await fetch('https://api.amazon.com/user/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!profileRes.ok) {
      throw new UnauthorizedException('Failed to fetch Amazon profile');
    }
    const profile = await profileRes.json();

    const amazonEmail = profile.email?.toLowerCase();
    if (!amazonEmail) {
      throw new BadRequestException('No email returned from Amazon');
    }

    const invited = await this.em.findOne(InvitedUser, { email: amazonEmail });
    if (!invited) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'Email not invited. Contact admin to get access.',
        error: 'NOT_INVITED',
      });
    }

    if (!invited.hasLoggedIn) {
      invited.hasLoggedIn = true;
      invited.name = profile.name || amazonEmail;
      invited.amazonProfileId = Number(profile.user_id) || undefined;
      await this.em.flush();
    }

    let user = await this.em.findOne(User, { amazonUserId: profile.user_id });
    if (user) {
      this.em.assign(user, { name: profile.name, lastLoginAt: new Date() });
    } else {
      user = this.em.create(User, {
        amazonUserId: profile.user_id,
        name: profile.name,
        email: profile.email,
        lastLoginAt: new Date(),
      });
    }
    await this.em.persist(user).flush();

    await this.sessionService.delete(existingSessionId);

    const newSessionId = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + tokenData.expires_in * 1000;

    const sessionData: SessionData = {
      userId: String(user.id),
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type,
      expires_at: expiresAt,
      oauthState: undefined,
    };

    await this.sessionService.create(newSessionId, sessionData, tokenData.expires_in - 60);

    return {
      sessionId: newSessionId,
      expiresIn: tokenData.expires_in,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      email: amazonEmail,
      name: profile.name,
    };
  }

  async getValidAccessToken(sessionId: string): Promise<string> {
    const session = await this.sessionService.get(sessionId);
    if (!session) {
      throw new UnauthorizedException('Session not found or expired');
    }
    const isExpiringSoon = session.expires_at - Date.now() < 60_000;
    if (isExpiringSoon) {
      return this.refreshAccessToken(sessionId, session.refresh_token);
    }
    return session.access_token;
  }

  async refreshAccessToken(sessionId: string, refreshToken: string): Promise<string> {
    const tokenData = await this.refreshAmazonToken(refreshToken);
    if (tokenData.error || !tokenData.access_token) {
      await this.sessionService.delete(sessionId);
      throw new UnauthorizedException('Token refresh failed, please re-authenticate');
    }
    await this.sessionService.update(
      sessionId,
      {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token ?? refreshToken,
        expires_at: Date.now() + tokenData.expires_in * 1000,
        oauthState: undefined,
      },
      tokenData.expires_in - 60,
    );
    return tokenData.access_token;
  }

  async refreshAmazonToken(refreshToken: string): Promise<AmazonTokenResponse> {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.get('AMAZON_CLIENT_ID')!,
        client_secret: this.config.get('AMAZON_CLIENT_SECRET')!,
      }),
    });
    return res.json() as Promise<AmazonTokenResponse>;
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessionService.delete(sessionId);
  }
}