// // src/modules/scheduler/scheduler.module.ts
// import { Module } from '@nestjs/common';
// import { BullModule } from '@nestjs/bullmq';
// import { SchedulerService } from './scheduler.service';
// import { SchedulerProcessor } from './scheduler.processor';
// import { SCHEDULER_QUEUE } from '../../common/bullmq/bullmq.constants';

// @Module({
//   imports: [BullModule.registerQueue({ name: SCHEDULER_QUEUE })],
//   providers: [SchedulerService, SchedulerProcessor],
// })
// export class SchedulerModule {}

// // src/modules/scheduler/scheduler.service.ts
// import { Injectable, OnModuleInit } from '@nestjs/common';
// import { InjectQueue } from '@nestjs/bullmq';
// import { Queue } from 'bullmq';
// import { SCHEDULER_QUEUE } from '../../common/bullmq/bullmq.constants';

// @Injectable()
// export class SchedulerService implements OnModuleInit {
//   constructor(@InjectQueue(SCHEDULER_QUEUE) private readonly queue: Queue) {}

//   async onModuleInit() {
//     // Every 15 minutes, check day-part rules
//     await this.queue.add('day-part-check', {}, {
//       repeat: { every: 15 * 60 * 1000 },
//       jobId: 'day-part-recurring',
//     });
//   }
// }
