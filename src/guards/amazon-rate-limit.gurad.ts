import { Injectable, CanActivate, ExecutionContext, HttpException } from '@nestjs/common';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

@Injectable()
export class AmazonRateLimitGuard implements CanActivate {
  private readonly requests = new Map<string, RateLimitRecord>();
  private readonly limit = 10;
  private readonly windowMs = 60000;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const clientId = req.headers['amazon-advertising-api-client-id'] || req.ip || 'unknown';
    const now = Date.now();

    const record = this.requests.get(clientId);

    if (!record || now > record.resetTime) {
      this.requests.set(clientId, { count: 1, resetTime: now + this.windowMs });
      this.setRateLimitHeaders(req.res, this.limit - 1, now + this.windowMs);
      return true;
    }

    if (record.count >= this.limit) {
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      this.setRateLimitHeaders(req.res, 0, record.resetTime);
      req.res.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          details: 'Too many requests. Please retry after the window resets.',
          retryAfter,
        },
        429,
      );
    }

    record.count++;
    this.setRateLimitHeaders(req.res, this.limit - record.count, record.resetTime);
    return true;
  }

  private setRateLimitHeaders(res: any, remaining: number, resetTime: number): void {
    if (!res) return;
    res.setHeader('x-amzn-RateLimit-Limit', String(this.limit));
    res.setHeader('x-amzn-RateLimit-Remaining', String(Math.max(0, remaining)));
    res.setHeader('x-amzn-RateLimit-Reset', String(Math.ceil(resetTime / 1000)));
  }
}