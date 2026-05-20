// // src/common/sse/sse.service.ts
// import { Injectable, OnModuleDestroy } from '@nestjs/common';
// import { Observable, Subject } from 'rxjs';
// import { createClient, RedisClientType } from 'redis';

// export interface SyncProgress {
//   step: number;
//   status: 'started' | 'progress' | 'completed' | 'failed';
//   message: string;
//   error?: string;
//   meta?: Record<string, any>;
// }

// @Injectable()
// export class SseService implements OnModuleDestroy {
//   private redisPub: RedisClientType;
//   private redisSub: RedisClientType;
//   private subscribers = new Map<string, Subject<SyncProgress>>();

//   constructor() {
//     this.redisPub = createClient({ url: process.env.REDIS_URL });
//     this.redisSub = createClient({ url: process.env.REDIS_URL });
    
//     this.redisPub.connect();
//     this.redisSub.connect().then(() => this.listen());
//   }

//   private async listen() {
//     // Subscribe to all progress channels
//     await this.redisSub.pSubscribe('sync:progress:*', (message, channel) => {
//       const jobId = channel.replace('sync:progress:', '');
//       const payload: SyncProgress = JSON.parse(message);
      
//       const subject = this.subscribers.get(jobId);
//       if (subject) {
//         subject.next(payload);
        
//         if (payload.status === 'completed' || payload.status === 'failed') {
//           setTimeout(() => this.unsubscribe(jobId), 5000); // cleanup
//         }
//       }
//     });
//   }

//   subscribeToJob(jobId: string): Observable<MessageEvent> {
//     const subject = new Subject<SyncProgress>();
//     this.subscribers.set(jobId, subject);

//     return new Observable((observer) => {
//       const sub = subject.subscribe({
//         next: (data) => observer.next({ data } as MessageEvent),
//         error: (err) => observer.error(err),
//         complete: () => observer.complete(),
//       });

//       return () => {
//         sub.unsubscribe();
//         this.unsubscribe(jobId);
//       };
//     });
//   }

//   private unsubscribe(jobId: string) {
//     this.subscribers.get(jobId)?.complete();
//     this.subscribers.delete(jobId);
//   }

//   // Called by the WORKER to broadcast progress
//   static async publishProgress(jobId: string, progress: SyncProgress) {
//     const pub = createClient({ url: process.env.REDIS_URL });
//     await pub.connect();
//     await pub.publish(`sync:progress:${jobId}`, JSON.stringify(progress));
//     await pub.disconnect();
//   }

//   onModuleDestroy() {
//     this.redisPub.disconnect();
//     this.redisSub.disconnect();
//   }
// }