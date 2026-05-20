// // src/worker.ts
// import { NestFactory } from '@nestjs/core';
// import { WorkerModule } from './worker.module';

// async function bootstrap() {
//   // No HTTP server, no controllers
//   const app = await NestFactory.createApplicationContext(WorkerModule, {
//     logger: ['error', 'warn', 'log'],
//   });

//   // Keep alive
//   process.on('SIGTERM', async () => {
//     console.log('Worker shutting down...');
//     await app.close();
//     process.exit(0);
//   });
// }

// bootstrap();

// // src/worker.module.ts
// import { Module } from '@nestjs/common';
// import { MikroOrmModule } from '@mikro-orm/nestjs';
// import { BullmqModule } from './common/bullmq/bullmq.module';
// import { SyncProcessor } from './modules/sync/sync.processor';
// import { SchedulerProcessor } from './modules/scheduler/scheduler.processor';
// import { AmazonAdvertisingService } from './modules/auth/amazon-advertising.service';
// import { Campaign } from './entities/campaign.entity';
// import { Profile } from './entities/profile.entity';
// import { SyncJobLog } from './entities/sync-job-log.entity';
// import { SchedulerLog } from './entities/scheduler-log.entity';

// @Module({
//   imports: [
//     MikroOrmModule.forRoot(/* your config */),
//     MikroOrmModule.forFeature([Campaign, Profile, SyncJobLog, SchedulerLog]),
//     BullmqModule,
//   ],
//   providers: [
//     SyncProcessor,
//     SchedulerProcessor,
//     AmazonAdvertisingService,
//   ],
// })
// export class WorkerModule {}