import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ProfileTokenService } from 'src/modules/session/service/profile-token.service';
import { REFRESH_JOB_DELAY_MS } from 'src/common/constants/bullmq.constant';
import { AMAZON_PROFILE_TOKEN_REFRESH } from 'src/common/constants/bullmq.constant';

@Processor(AMAZON_PROFILE_TOKEN_REFRESH)
export class AmazonProfileTokenRefreshProcessor extends WorkerHost {
  private readonly logger = new Logger(AmazonProfileTokenRefreshProcessor.name);

  constructor(
    private readonly profileTokenService: ProfileTokenService,
    @InjectQueue(AMAZON_PROFILE_TOKEN_REFRESH) private readonly tokenRefreshQueue: Queue,
  ) {
    super();
    this.logger.log(`🔥 WORKER STARTED for queue: ${AMAZON_PROFILE_TOKEN_REFRESH}`);
  }

  async process(job: Job<{ profileId: number }>): Promise<void> {
    const { profileId } = job.data;
    let keepRefreshing = true;

    try {
      // Falls back to the Postgres copy if the Redis key was lost; only
      // returns null when the refresh token is gone or permanently rejected.
      const token = await this.profileTokenService.getValidToken(profileId, { forceRefresh: true });
      if (!token) {
        this.logger.warn(`Profile ${profileId} has no usable refresh token; stopping its refresh chain until the user reconnects`);
        keepRefreshing = false;
        return;
      }
      this.logger.log(`Refreshed profile token for profile ${profileId}`);
    } catch (err: any) {
      // Transient (network / 5xx / throttling). The stored token is kept, and
      // scheduled jobs refresh on demand, so just log and try again next cycle.
      this.logger.error(`Profile token refresh failed for profile ${profileId}: ${err.message}`);
    } finally {
      // The chain continues even when this run failed — a single bad refresh
      // used to end it for good. Skip if another chain for this profile exists.
      if (keepRefreshing) await this.scheduleNext(profileId, job.id);
    }
  }

  private async scheduleNext(profileId: number, currentJobId?: string): Promise<void> {
    try {
      const upcoming = await this.tokenRefreshQueue.getJobs(['delayed', 'waiting']);
      const alreadyScheduled = upcoming.some((j) => j.id !== currentJobId && j.data?.profileId === profileId);
      if (alreadyScheduled) return;

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
    } catch (err: any) {
      this.logger.error(`Could not schedule next token refresh for profile ${profileId}: ${err.message}`);
    }
  }
}
