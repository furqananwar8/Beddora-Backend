// // src/common/bullmq/bullmq.constants.ts
// export const SYNC_QUEUE = 'sync-queue';
// export const SCHEDULER_QUEUE = 'scheduler-queue';

// // src/common/bullmq/bullmq.module.ts
// import { Module } from '@nestjs/common';
// import { BullModule } from '@nestjs/bullmq';

// @Module({
//   imports: [
//     BullModule.forRoot({
//       connection: {
//         host: process.env.REDIS_HOST,
//         port: process.env.REDIS_PORT,
//       },
//       defaultJobOptions: {
//         removeOnComplete: 50,
//         removeOnFail: 100,
//         attempts: 3,
//         backoff: { type: 'exponential', delay: 5000 },
//       },
//     }),
//     BullModule.registerQueue(
//       { name: SYNC_QUEUE },
//       { name: SCHEDULER_QUEUE },
//     ),
//   ],
//   exports: [BullModule],
// })
// export class BullmqModule {}