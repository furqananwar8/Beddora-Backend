// // src/modules/sync/sync.processor.ts
// import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
// import { Job } from 'bullmq';
// import { EntityManager } from '@mikro-orm/core';
// import { SYNC_QUEUE } from '../../common/bullmq/bullmq.constants';
// import { SseService, SyncProgress } from '../../common/sse/sse.service';
// import { AmazonAdvertisingService } from '../auth/amazon-advertising.service';
// import { Campaign } from '../../entities/campaign.entity';
// import { Profile } from '../../entities/profile.entity';
// import { SyncJobLog } from '../../entities/sync-job-log.entity';

// @Processor(SYNC_QUEUE, { concurrency: 3 })
// export class SyncProcessor extends WorkerHost {
//   constructor(
//     private readonly em: EntityManager,
//     private readonly amazon: AmazonAdvertisingService,
//   ) {
//     super();
//   }

//   async process(job: Job<{ adminId: string; type: string }>): Promise<any> {
//     const startTime = Date.now();
//     const log = new SyncJobLog();
//     log.jobId = job.id!;
//     log.type = job.data.type;
//     log.status = 'running';
    
//     await this.em.persistAndFlush(log);

//     try {
//       await this.runSync(job);
      
//       log.status = 'completed';
//       log.duration = Date.now() - startTime;
//       await this.em.flush();
      
//       return { success: true };
//     } catch (error) {
//       log.status = 'failed';
//       log.error = error.message;
//       log.duration = Date.now() - startTime;
//       await this.em.flush();
//       throw error;
//     }
//   }

//   private async runSync(job: Job) {
//     // Step 1: Started
//     await this.report(job, { step: 1, status: 'started', message: 'Connecting to Amazon...' });

//     // Step 2: Pull profiles
//     await this.report(job, { step: 2, status: 'progress', message: 'Pulling profiles...' });
//     const profiles = await this.amazon.getProfiles();
    
//     const totalCampaigns = { sp: 0, sb: 0, sd: 0 };
//     const allCampaigns: Campaign[] = [];

//     // Step 3: SP Campaigns
//     await this.report(job, { step: 3, status: 'progress', message: 'Pulling SP campaigns...' });
//     for (const profile of profiles) {
//       const campaigns = await this.amazon.getSPCampaigns(profile.profileId);
//       totalCampaigns.sp += campaigns.length;
//       allCampaigns.push(...campaigns.map(c => this.mapCampaign(c, profile, 'sp')));
//     }
//     await this.report(job, { 
//       step: 3, 
//       status: 'progress', 
//       message: `Pulling SP campaigns... (${totalCampaigns.sp} found)`,
//       meta: { spCount: totalCampaigns.sp }
//     });

//     // Step 4: SB Campaigns
//     await this.report(job, { step: 4, status: 'progress', message: 'Pulling SB campaigns...' });
//     for (const profile of profiles) {
//       const campaigns = await this.amazon.getSBCampaigns(profile.profileId);
//       totalCampaigns.sb += campaigns.length;
//       allCampaigns.push(...campaigns.map(c => this.mapCampaign(c, profile, 'sb')));
//     }
//     await this.report(job, { 
//       step: 4, 
//       status: 'progress', 
//       message: `Pulling SB campaigns... (${totalCampaigns.sb} found)`,
//       meta: { sbCount: totalCampaigns.sb }
//     });

//     // Step 5: SD Campaigns
//     await this.report(job, { step: 5, status: 'progress', message: 'Pulling SD campaigns...' });
//     for (const profile of profiles) {
//       const campaigns = await this.amazon.getSDCampaigns(profile.profileId);
//       totalCampaigns.sd += campaigns.length;
//       allCampaigns.push(...campaigns.map(c => this.mapCampaign(c, profile, 'sd')));
//     }
//     await this.report(job, { 
//       step: 5, 
//       status: 'progress', 
//       message: `Pulling SD campaigns... (${totalCampaigns.sd} found)`,
//       meta: { sdCount: totalCampaigns.sd }
//     });

//     // Step 6: Sync to DB
//     await this.report(job, { step: 6, status: 'progress', message: 'Syncing to database...' });
//     await this.upsertCampaigns(allCampaigns);

//     // Step 7: Complete
//     const total = totalCampaigns.sp + totalCampaigns.sb + totalCampaigns.sd;
//     await this.report(job, { 
//       step: 7, 
//       status: 'completed', 
//       message: `Sync complete. ${total} campaigns updated.`,
//       meta: { total, ...totalCampaigns }
//     });
//   }

//   private async report(job: Job, progress: SyncProgress) {
//     // Update BullMQ job progress (for BullMQ dashboard)
//     await job.updateProgress(progress);
    
//     // Publish to Redis for SSE stream
//     await SseService.publishProgress(job.id!, progress);
//   }

//   private mapCampaign(raw: any, profile: Profile, type: string): Campaign {
//     const campaign = new Campaign();
//     campaign.externalId = raw.campaignId;
//     campaign.name = raw.name;
//     campaign.type = type;
//     campaign.profile = profile;
//     campaign.state = raw.state;
//     campaign.budget = raw.dailyBudget || raw.budget;
//     campaign.startDate = raw.startDate;
//     campaign.endDate = raw.endDate;
//     campaign.targetingType = raw.targetingType;
//     campaign.lastSyncedAt = new Date();
//     return campaign;
//   }

//   private async upsertCampaigns(campaigns: Campaign[]) {
//     // Batch upsert with MikroORM
//     for (const campaign of campaigns) {
//       const existing = await this.em.findOne(Campaign, { externalId: campaign.externalId });
//       if (existing) {
//         this.em.assign(existing, campaign);
//       } else {
//         this.em.persist(campaign);
//       }
//     }
//     await this.em.flush();
//   }

//   @OnWorkerEvent('failed')
//   async onFailed(job: Job, error: Error) {
//     await SseService.publishProgress(job.id!, {
//       step: (job.progress as any)?.step || 0,
//       status: 'failed',
//       message: error.message,
//       error: error.stack,
//     });
//   }
// }