import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { SessionData, SessionService } from 'src/modules/session/service/session.service';


interface AmazonTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number; // seconds
  error?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private config: ConfigService,
    private sessionService: SessionService,
  ) {}

  // Step 1 — Exchange authorization code for tokens
  async exchangeCodeForTokens(code: string): Promise<{ sessionId: string; expiresIn: number }> {
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.get('AMAZON_CLIENT_ID')!,
        client_secret: this.config.get('AMAZON_CLIENT_SECRET')!,
        redirect_uri: this.config.get('AMAZON_REDIRECT_URI')!,
      }),
    });

    const tokenData: AmazonTokenResponse = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      throw new UnauthorizedException(`Amazon token exchange failed: ${tokenData.error}`);
    }

    const sessionId = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + tokenData.expires_in * 1000;

    const sessionData: SessionData = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type,
      expires_at: expiresAt,
    };

    // TTL slightly less than token expiry so session dies with the token
    await this.sessionService.create(sessionId, sessionData, tokenData.expires_in - 60);

    return { sessionId, expiresIn: tokenData.expires_in };
  }

  // Step 2 — Retrieve a valid access token for a session (auto-refreshes if expired)
  async getValidAccessToken(sessionId: string): Promise<string> {
    const session = await this.sessionService.get(sessionId);

    if (!session) {
      throw new UnauthorizedException('Session not found or expired');
    }

    // If token expires in less than 60s, proactively refresh
    const isExpiringSoon = session.expires_at - Date.now() < 60_000;

    if (isExpiringSoon) {
      return this.refreshAccessToken(sessionId, session.refresh_token);
    }

    return session.access_token;
  }

  // Step 3 — Refresh token flow
  private async refreshAccessToken(sessionId: string, refreshToken: string): Promise<string> {
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

    const tokenData: AmazonTokenResponse = await res.json();

    if (tokenData.error || !tokenData.access_token) {
      // Refresh failed — force re-login
      await this.sessionService.delete(sessionId);
      throw new UnauthorizedException('Token refresh failed, please re-authenticate');
    }

    // Update session with fresh tokens
    await this.sessionService.update(
      sessionId,
      {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token ?? refreshToken, // Amazon may or may not rotate it
        expires_at: Date.now() + tokenData.expires_in * 1000,
      },
      tokenData.expires_in - 60,
    );

    return tokenData.access_token;
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessionService.delete(sessionId);
  }
}