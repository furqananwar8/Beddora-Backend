import { defineConfig } from '@mikro-orm/postgresql';
import { config } from 'dotenv';
import { User } from './entities/user.entity';
import { Campaign } from './entities/campaigns.entity';
import { AmazonCampaign } from './entities/amazon-campaign.entity';
import { CampaignSchedule } from './entities/campaign-schedule.entity';

config();

export default defineConfig({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  dbName: process.env.DB_NAME,
  entities: [User, Campaign, AmazonCampaign, CampaignSchedule],
  debug: true,
  migrations: {
    path: './migrations',
    pathTs: './src/migrations',
  },
});