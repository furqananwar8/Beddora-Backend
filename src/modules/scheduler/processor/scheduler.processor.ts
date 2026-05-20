// / src/modules/scheduler/scheduler.processor.ts
// import { Processor, WorkerHost } from '@nestjs/bullmq';
// import { Job } from 'bullmq';
// import { EntityManager } from '@mikro-orm/core';
// import { SCHEDULER_QUEUE } from '../../common/bullmq/bullmq.constants';
// import { Campaign } from '../../entities/campaign.entity';
// import { SchedulerRule } from '../../entities/scheduler-rule.entity';
// import { SchedulerLog } from '../../entities/scheduler-log.entity';
// import { AmazonAdvertisingService } from '../auth/amazon-advertising.service';

// @Processor(SCHEDULER_QUEUE, { concurrency: 1 })
// export class SchedulerProcessor extends WorkerHost {
//   constructor(
//     private readonly em: EntityManager,
//     private readonly amazon: AmazonAdvertisingService,
//   ) {
//     super();
//   }

//   async process(job: Job): Promise<void> {
//     const now = new Date();
//     const dayOfWeek = now.getDay(); // 0-6
//     const hour = now.getHours();
//     const minute = now.getMinutes();
//     const currentTime = hour * 60 + minute; // minutes since midnight

//     // Find active rules that match current day/time
//     const rules = await this.em.find(SchedulerRule, {
//       isActive: true,
//       dayOfWeek,
//       $and: [
//         { startMinute: { $lte: currentTime } },
//         { endMinute: { $gte: currentTime } },
//       ],
//     }, { populate: ['campaign'] });

//     for (const rule of rules) {
//       const campaign = rule.campaign;
//       const shouldBeEnabled = rule.action === 'enable';
      
//       // Only act if state needs to change
//       if ((shouldBeEnabled && campaign.state !== 'enabled') ||
//           (!shouldBeEnabled && campaign.state !== 'paused')) {
        
//         await this.amazon.updateCampaignState(campaign.externalId, shouldBeEnabled ? 'enabled' : 'paused');
        
//         campaign.state = shouldBeEnabled ? 'enabled' : 'paused';
        
//         const log = new SchedulerLog();
//         log.campaign = campaign;
//         log.rule = rule;
//         log.action = rule.action;
//         log.executedAt = new Date();
        
//         this.em.persist(log);
//       }
//     }

//     await this.em.flush();
//   }
// }