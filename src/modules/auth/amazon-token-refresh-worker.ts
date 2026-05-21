import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { User } from 'src/entities/user.entity';
import { SessionService } from '../session/service/session.service';
import { AuthService } from './service/auth.service';
import { REFRESH_JOB_DELAY_MS } from 'src/common/constants/bullmq.constant';
import { AMAZON_TOKEN_REFRESH } from 'src/common/constants/bullmq.constant';

@Processor(AMAZON_TOKEN_REFRESH)
export class AmazonTokenRefreshProcessor extends WorkerHost {
  private readonly logger = new Logger(AmazonTokenRefreshProcessor.name);

  constructor(
    private readonly sessionService: SessionService,
    private readonly authService: AuthService,
    @InjectQueue(AMAZON_TOKEN_REFRESH) private readonly tokenRefreshQueue: Queue
  ) {
    super();
  }

  async process(job: Job<{ sessionId: string }>): Promise<void> {
    const { sessionId } = job.data;

    const session = await this.sessionService.get(sessionId);
    if (!session) {
      this.logger.warn(`Session ${sessionId} gone, dropping refresh job`);
      return;
    }

    try {
      await this.authService.refreshAccessToken(
        sessionId,
        session.refresh_token,
      );

      this.logger.log(`Refreshed token for session ${sessionId}`);

      await this.tokenRefreshQueue.add(
        'refresh',
        { sessionId },
        { delay: REFRESH_JOB_DELAY_MS },
      );
    } catch (err) {
      this.logger.error(`Refresh failed for ${sessionId}`, err);
      throw err;
    }
  }
}