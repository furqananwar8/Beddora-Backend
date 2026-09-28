import { ConfigService } from '@nestjs/config';

export interface AmazonTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Exchange a Login-with-Amazon refresh token for a new access token. */
export async function requestAmazonTokenRefresh(
  config: ConfigService,
  refreshToken: string,
): Promise<AmazonTokenResponse> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.get('AMAZON_CLIENT_ID')!,
      client_secret: config.get('AMAZON_CLIENT_SECRET')!,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json() as Promise<AmazonTokenResponse>;
}

/**
 * `invalid_grant` means the refresh token itself was revoked/expired; the
 * user must reconnect. Anything else (5xx, throttling, network) is transient
 * and must NOT cause the stored token to be deleted.
 */
export function isPermanentRefreshError(error?: string): boolean {
  return error === 'invalid_grant' || error === 'unauthorized_client' || error === 'invalid_client';
}
