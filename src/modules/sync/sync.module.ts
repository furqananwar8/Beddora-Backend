// // src/modules/sync/sync.module.ts
// import { Module } from '@nestjs/common';
// import { BullModule } from '@nestjs/bullmq';
// import { SyncController } from './sync.controller';
// import { SyncService } from './sync.service';
// import { SyncQueueService } from './sync-queue.service';
// import { SseService } from '../../common/sse/sse.service';
// import { SYNC_QUEUE } from '../../common/bullmq/bullmq.constants';

// @Module({
//   imports: [BullModule.registerQueue({ name: SYNC_QUEUE })],
//   controllers: [SyncController],
//   providers: [SyncService, SyncQueueService, SseService],
//   exports: [SyncQueueService],
// })
// export class SyncModule {}



// // src/modules/sync/sync.controller.ts
