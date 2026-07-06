import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ProfileTokenService } from 'src/modules/session/service/profile-token.service';
import { AuthService } from './service/auth.service';
import { REFRESH_JOB_DELAY_MS } from 'src/common/constants/bullmq.constant';
import { AMAZON_PROFILE_TOKEN_REFRESH } from 'src/common/constants/bullmq.constant';

@Processor(AMAZON_PROFILE_TOKEN_REFRESH)
export class AmazonProfileTokenRefreshProcessor extends WorkerHost {
  private readonly logger = new Logger(AmazonProfileTokenRefreshProcessor.name);

  constructor(
    private readonly profileTokenService: ProfileTokenService,
    private readonly authService: AuthService,
    @InjectQueue(AMAZON_PROFILE_TOKEN_REFRESH) private readonly tokenRefreshQueue: Queue,
  ) {
    super();
    this.logger.log(`🔥 WORKER STARTED for queue: ${AMAZON_PROFILE_TOKEN_REFRESH}`);
  }

  async process(job: Job<{ profileId: number }>): Promise<void> {
    const { profileId } = job.data;

    const token = await this.profileTokenService.get(profileId);
    if (!token) {
      this.logger.warn(`Profile token for profile ${profileId} gone, dropping refresh job`);
      return;
    }

    try {
      const tokenData = await this.authService.refreshAmazonToken(token.refresh_token);

      if (tokenData.error || !tokenData.access_token) {
        this.logger.error(`Amazon refresh failed for profile ${profileId}: ${tokenData.error}`);
        await this.profileTokenService.delete(profileId);
        throw new Error(`Token refresh failed: ${tokenData.error}`);
      }

      const expiresIn = tokenData.expires_in;
      const newRefreshToken = tokenData.refresh_token ?? token.refresh_token;

      await this.profileTokenService.update(
        profileId,
        {
          access_token: tokenData.access_token,
          refresh_token: newRefreshToken,
          expires_at: Date.now() + expiresIn * 1000,
        },
        expiresIn - 60,
      );

      this.logger.log(`Refreshed profile token for profile ${profileId}`);

      await this.tokenRefreshQueue.add(
        'refresh-service',
        { profileId },
        {
          delay: REFRESH_JOB_DELAY_MS,
          attempts: 3,
          removeOnFail: { count: 5 },
          removeOnComplete: { count: 10 },
        },
      );
    } catch (err) {
      this.logger.error(`Profile token refresh failed for profile ${profileId}`, err);
      throw err;
    }
  }
}