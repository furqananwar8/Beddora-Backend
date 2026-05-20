import {
  Controller,
  Get,
  Query,
  Res,
  Req,
  Post,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiCookieAuth } from '@nestjs/swagger';
import { AuthService } from '../service/auth.service';

const SESSION_COOKIE = 'sid';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Get('amazon/callback')
  @ApiOperation({
    summary: 'Amazon OAuth callback',
    description: 'Exchanges the authorization code from Amazon for tokens, creates a server-side session and sets an HTTP-only cookie.',
  })
  @ApiQuery({ name: 'code', required: false, description: 'Authorization code returned by Amazon' })
  @ApiQuery({ name: 'error', required: false, description: 'Error returned by Amazon if user denied access' })
  @ApiResponse({ status: 302, description: 'Session created — redirects to frontend with sid cookie set' })
  @ApiResponse({ status: 400, description: 'Missing code or Amazon returned an error' })
  async amazonCallback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      throw new BadRequestException(`Amazon OAuth error: ${error}`);
    }

    if (!code) {
      throw new BadRequestException('Missing authorization code');
    }

    const { sessionId, expiresIn } = await this.authService.exchangeCodeForTokens(code);

    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: (expiresIn - 60) * 1000,
      path: '/',
    });

    return res.redirect(process.env.FRONTEND_REDIRECT_URL ?? '/dashboard');
  }

  @Get('me')
  @ApiCookieAuth('sid')
  @ApiOperation({
    summary: 'Validate current session',
    description: 'Reads the sid cookie, checks session validity in Redis, and auto-refreshes the Amazon token if expiring soon.',
  })
  @ApiResponse({ status: 200, description: 'Session is valid', schema: { example: { authenticated: true } } })
  @ApiResponse({ status: 401, description: 'No session cookie or session expired' })
  async getSession(@Req() req: Request) {
    const sessionId = req.cookies?.[SESSION_COOKIE];

    if (!sessionId) {
      throw new UnauthorizedException('No session');
    }

    await this.authService.getValidAccessToken(sessionId);

    return { authenticated: true };
  }

  @Post('logout')
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
    return res.json({ success: true });
  }
}