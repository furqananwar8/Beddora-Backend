import { defineConfig } from '@mikro-orm/postgresql';
import { config } from 'dotenv';
import { User } from './entities/user.entity';
import { CampaignSchedule } from './entities/campaign-schedule.entity';
import { ScheduleJob } from './entities/schedule-job.entity';
import { InvitedUser } from './entities/invited-user';

config();

export default defineConfig({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  dbName: process.env.DB_NAME,
  entities: [User, CampaignSchedule, ScheduleJob, InvitedUser],
  debug: true,
  migrations: {
    path: './migrations',
    pathTs: './src/migrations',
  },
});