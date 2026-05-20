// // src/modules/sync/sync-queue.service.ts
// import { Injectable } from '@nestjs/common';
// import { InjectQueue } from '@nestjs/bullmq';
// import { Queue } from 'bullmq';
// import { SYNC_QUEUE } from '../../common/bullmq/bullmq.constants';

// @Injectable()
// export class SyncQueueService {
//   constructor(@InjectQueue(SYNC_QUEUE) private readonly syncQueue: Queue) {}

//   async addManualSync(adminId: string) {
//     const job = await this.syncQueue.add('manual-sync', {
//       adminId,
//       triggeredAt: new Date().toISOString(),
//       type: 'manual',
//     });
//     return { jobId: job.id };
//   }

//   async addAutoSync() {
//     return this.syncQueue.add('auto-sync', {
//       type: 'auto',
//       triggeredAt: new Date().toISOString(),
//     }, {
//       repeat: { every: 30 * 60 * 1000 }, // 30 min
//       jobId: 'auto-sync-recurring',
//     });
//   }
// }