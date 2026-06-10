import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiBody,
} from '@nestjs/swagger';
import { EntityManager } from '@mikro-orm/core';
import type { Request } from 'express';
import { CampaignSchedule } from 'src/entities/campaign-schedule.entity';
import { ScheduleJob } from 'src/entities/schedule-job.entity';
import { AmazonProfile, SessionAuthGuard } from 'src/guards/SessionAuth.guard';
import { SessionService } from 'src/modules/session/service/session.service';
import * as amazonApiClient from '../../amazon/client/amazon-api.client';
import { ScheduleExpanderService } from '../service/schedule-expander.service';
import { SESSION_COOKIE } from 'src/common/constants/session.constant';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CreateSchedulesDTO } from '../dto/create-schedules.dto';

@ApiTags('Campaigns')
@Controller('campaigns')
export class CampaignController {
  constructor(
    private readonly em: EntityManager,
    private readonly amazonClient: amazonApiClient.AmazonCampaignApiClient,
    private readonly sessionService: SessionService,
    private readonly expander: ScheduleExpanderService,
    @InjectQueue('campaign-scheduler') private readonly schedulerQueue: Queue,
  ) {}

  private async getSessionToken(req: Request) {
    const sessionId = req.cookies?.[SESSION_COOKIE];
    const session = await this.sessionService.get(sessionId);
    if (!session?.access_token) throw new UnauthorizedException('No Amazon token');
    return session;
  }

 @Get()
@UseGuards(SessionAuthGuard)
@ApiCookieAuth('sid')
@ApiOperation({ summary: 'List campaigns by type (cursor-based)' })
@ApiQuery({ name: 'type', required: true, enum: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] })
@ApiQuery({ name: 'limit', required: false })
@ApiQuery({ name: 'cursor', required: false })
@ApiQuery({ name: 'search', required: false })
@ApiQuery({ name: 'state', required: false })
async listCampaigns(
  @Req() req: Request,
  @Query('type') type: amazonApiClient.AmazonAdProduct,
  @Query('limit') limit: string = '15',
  @Query('cursor') cursor?: string,
  @Query('search') search?: string,
  @Query('state') state?: string,
) {
  const session = await this.getSessionToken(req);

  const profiles = session.profiles?.length
    ? session.profiles
    : session.profileId
      ? [{ profileId: session.profileId, region: (session?.region as any) || 'na', countryCode: session.countryCode || 'US' }]
      : [];

  if (!profiles.length) {
    throw new BadRequestException('No Amazon Advertising profile linked. Complete OAuth first.');
  }

  const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 15, 100));

  const { data: campaigns, meta } = await this.amazonClient.queryCampaignsByType({
    accessToken: session.access_token,
    profiles,
    type,
    limit: limitNum,
    profileId: session.profileId as number,
    search,
    state,
    cursor: cursor || null,
  });

  const allProfileIds = profiles.map((p) => p.profileId);
  const em = this.em.fork();
  const schedules = await em.find(CampaignSchedule, {
    profileId: { $in: allProfileIds },
    campaignId: { $in: campaigns.map((c) => String(c.campaignId)) },
  });

  const merged = campaigns.map((c) => ({
    campaignId: String(c.campaignId),
    name: c.name,
    state: c.state,
    adProduct: c.adProduct,
    countryCode: c.countryCode,
    profileId: c.profileId,
    creationDate: c.creationDateTime,
    lastUpdated: c.lastUpdatedDateTime,
    dailyBudget: c.budgets?.[0]?.amount,
    schedules: schedules.filter((s) => s.campaignId === String(c.campaignId)),
  }));

  return { data: merged, meta };
}

  @Post(':campaignId/schedule')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({ summary: 'Create recurring day-parting schedules by day-of-week' })
  @ApiBody({
    schema: {
      example: {
        schedules: [
          { dayOfWeek: 1, timeSlots: [{ startTime: '09:00', endTime: '14:00' }], action: 'ENABLED' },
          { dayOfWeek: 3, timeSlots: [{ startTime: '13:00', endTime: '17:00' }], action: 'ENABLED' },
        ],
      },
    },
  })
  async createSchedule(
    @Param('campaignId') campaignId: string,
    @Req() req: Request,
    @Body() body: CreateSchedulesDTO,
  ) {
    console.log("Request received", {body})
    if (!body.schedules?.length) {
      throw new BadRequestException('schedules array is required');
    }

    const sessionId = req.cookies[SESSION_COOKIE];
    const session = await this.sessionService.get(sessionId);

    if (!session?.profileId) {
      throw new BadRequestException('No Amazon Advertising profile linked to session');
    }
    console.log({campaignId})
    const result = await this.expander.syncSchedules(
      campaignId,
      session.profileId as number,
      (session.region as string) || 'na',
      sessionId,
      body.schedules,
    );

    return { 
      message: 'Schedules synced', 
      campaignId, 
      ...result 
    };
  }

  @Get(':campaignId/jobs')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({ summary: 'List pending/completed jobs for a campaign' })
  async getCampaignJobs(
    @Param('campaignId') campaignId: string,
    @Query('status') status?: 'pending' | 'completed' | 'failed',
  ) {
    const em = this.em.fork();
    const where: any = { campaignId };
    if (status) where.status = status;

    const jobs = await em.find(ScheduleJob, where, {
      orderBy: { executeAt: 'ASC' },
      populate: ['schedule'],
    });

    return {
      campaignId,
      jobs: jobs.map((j) => ({
        id: j.id,
        executeAt: j.executeAt,
        jobType: j.jobType,
        action: j.action,
        status: j.status,
        errorMessage: j.errorMessage,
      })),
    };
  }

  @Delete('schedules/:id')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({ summary: 'Cancel a schedule and all its pending jobs' })
  async deleteSchedule(@Param('id') id: string) {
    const em = this.em.fork();
    const schedule = await em.findOne(CampaignSchedule, { id: parseInt(id) }, {
      populate: ['jobs'],
    });

    if (!schedule) throw new BadRequestException('Schedule not found');

    for (const job of schedule.jobs) {
      if (job.status === 'pending') {
        try {
          const bullJob = await this.schedulerQueue.getJob(`schedule-${job.id}`);
          if (bullJob) await bullJob.remove();
        } catch {
          // ignore if already processed or missing
        }
        job.status = 'cancelled'; // ← ADD THIS
      }
    }

    schedule.isActive = false;
    await em.flush();
    return { message: 'Schedule cancelled' };
  }
}