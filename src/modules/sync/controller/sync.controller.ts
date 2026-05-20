// import { Controller, Get, Param, Sse, Post } from '@nestjs/common';
// import { Observable } from 'rxjs';
// import { SyncService } from './sync.service';
// import { SyncQueueService } from './sync-queue.service';
// import { SseService } from '../../common/sse/sse.service';

// @Controller('sync')
// export class SyncController {
//   constructor(
//     private readonly syncService: SyncService,
//     private readonly syncQueue: SyncQueueService,
//     private readonly sseService: SseService,
//   ) {}

//   @Post('now')
//   async syncNow() {
//     // Admin clicks "Sync Now"
//     const { jobId } = await this.syncQueue.addManualSync('admin-id');
//     return { jobId };
//   }

//   @Sse('progress/:jobId')
//   syncProgress(@Param('jobId') jobId: string): Observable<MessageEvent> {
//     // Frontend opens SSE with returned jobId
//     return this.sseService.subscribeToJob(jobId);
//   }
// }