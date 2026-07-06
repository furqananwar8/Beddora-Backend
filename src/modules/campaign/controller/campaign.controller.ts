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
  Logger,
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

  private readonly logger = new Logger(CampaignController.name);
  

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
    const sessionId = req.cookies[SESSION_COOKIE];
    const session = await this.sessionService.get(sessionId);

    if (!session?.profileId) {
      throw new BadRequestException('No Amazon Advertising profile linked to session');
    }

    // If empty array → clear all schedules for this campaign
    if (!body.schedules || body.schedules.length === 0) {
      const result = await this.expander.clearAllSchedules(campaignId);
      return {
        message: 'All schedules cleared',
        campaignId,
        ...result,
      };
    }

    // Otherwise sync as usual
    const result = await this.expander.syncSchedules(
      campaignId,
      session.profileId as number,
      (session.region as string) || 'na',
      sessionId,
      body.schedules,
      body.campaignName
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

  @Post('scheduler/repair')
  @UseGuards(SessionAuthGuard)
  async repairScheduler() {
    const result = await this.expander.repairOrphanedJobs();
    return { repaired: result };
  }

  @Get('scheduled-jobs')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({ summary: 'List all scheduled jobs across campaigns with pagination' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'] })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['executeAt', 'createdAt', 'status'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'campaignId', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search by campaign name' })
  async getAllScheduledJobs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('campaignId') campaignId?: string,
    @Query('search') search?: string,
  ) {
    const em = this.em.fork();
    
    const pageNum = Math.max(1, parseInt(page || '1', 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit || '20', 10)));
    const offset = (pageNum - 1) * limitNum;
    
    const where: any = {};
    
    // Optional filter by campaign
    if (campaignId) {
      where.campaignId = campaignId;
    }
    
    if (status && ['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(status)) {
      where.status = status;
    }

    // Search by campaign name (case-insensitive)
    if (search?.trim()) {
      where.campaignName = { $ilike: `%${search.trim()}%` };
    }
    
    const orderBy: any = {};
    const sortField = sortBy || 'executeAt';
    orderBy[sortField] = sortOrder || 'asc';
    
    const [jobs, total] = await em.findAndCount(ScheduleJob, where, {
      orderBy,
      limit: limitNum,
      offset,
      populate: ['schedule'],
    });
    
    const totalPages = Math.ceil(total / limitNum);
    
    return {
      data: jobs.map((j) => ({
        id: j.id,
        campaignId: j.campaignId,
        campaignName: j.campaignName || j.schedule?.campaignName,
        profileId: j.profileId,
        region: j.region,
        executeAt: j.executeAt,
        jobType: j.jobType,
        action: j.action,
        status: j.status,
        errorMessage: j.errorMessage,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
        schedule: j.schedule ? {
          id: j.schedule.id,
          dayOfWeek: j.schedule.dayOfWeek,
          timeSlots: j.schedule.timeSlots,
          action: j.schedule.action,
          isActive: j.schedule.isActive,
        } : null,
      })),
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
        hasNext: pageNum < totalPages,
        hasPrev: pageNum > 1,
      },
    };
  }

 @Delete('scheduled-jobs')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({ summary: 'Delete all future and failed scheduled jobs across all campaigns' })
  @ApiQuery({ name: 'campaignId', required: false, type: String })
  async deleteAllFutureScheduledJobs(
    @Query('campaignId') campaignId?: string,
  ) {
    const em = this.em.fork();
    const now = new Date();

    const where: any = {
      $or: [
        { executeAt: { $gt: now } },
        { status: 'failed' },
      ],
    };

    if (campaignId) {
      where.campaignId = campaignId;
    }

    const jobsToDelete = await em.find(ScheduleJob, where, {
      populate: ['schedule'],
    });

    const deletedJobIds = new Set(jobsToDelete.map(j => j.id));
    const schedulesToCheck = new Set<CampaignSchedule>();
    let deletedCount = 0;

    for (const job of jobsToDelete) {
      if (job.schedule) {
        schedulesToCheck.add(job.schedule);
      }

      // ── FIX: Always check BullMQ, not just pending ──
      try {
        const bullJob = await this.schedulerQueue.getJob(`schedule-${job.id}`);
        if (bullJob) {
          const state = await bullJob.getState();

          if (state === 'active') {
            this.logger.warn(
              `[DELETE] Job schedule-${job.id} is ACTIVE — skipping removal, ` +
              `will fail naturally on missing DB record`
            );
          } else {
            await bullJob.remove();
            this.logger.log(`[DELETE] Removed BullMQ job schedule-${job.id} (state: ${state})`);
          }
        } else {
          this.logger.log(`[DELETE] BullMQ job schedule-${job.id} already removed`);
        }
      } catch (err: any) {
        this.logger.error(`[DELETE] Error with BullMQ job schedule-${job.id}: ${err.message}`);
      }

      em.remove(job);
      deletedCount++;
    }

    // Schedule cleanup (unchanged)
    for (const schedule of schedulesToCheck) {
      await em.populate(schedule, ['jobs']);

      const remainingJobs = schedule.jobs.getItems().filter(
        (j: ScheduleJob) => !deletedJobIds.has(j.id)
      );

      const hasRemainingFutureJobs = remainingJobs.some(
        (j: ScheduleJob) => j.executeAt && j.executeAt > now
      );

      if (remainingJobs.length === 0) {
        this.logger.log(`[DELETE] Schedule ${schedule.id} has no jobs left, deleting`);
        em.remove(schedule);
      } else if (!hasRemainingFutureJobs) {
        this.logger.log(`[DELETE] Schedule ${schedule.id} has only past jobs, marking inactive`);
        schedule.isActive = false;
        schedule.updatedAt = new Date();
      } else {
        this.logger.log(`[DELETE] Schedule ${schedule.id} still has future jobs, keeping active`);
      }
    }

    await em.flush();

    return {
      message: `Deleted ${deletedCount} scheduled jobs${campaignId ? ` for campaign ${campaignId}` : ' across all campaigns'}`,
      deletedCount,
    };
  }

  // Add temporarily to your AuthController or a test controller
  // @Post('test/fail-job')
  // @ApiOperation({ summary: 'Test job failure email (dev only)' })
  // async testJobFailure() {
  //   const em = this.em.fork();

  //   // Create a fake campaign schedule first
  //   const fakeSchedule = em.create(CampaignSchedule, {
  //     campaignId: 'test-campaign-123',
  //     profileId: 12345,
  //     region: 'na',
  //     dayOfWeek: 1,
  //     action: 'ENABLED',
  //     timeSlots: [{ startTime: '09:00', endTime: '17:00' }],
  //     isActive: true,
  //     sessionId: 'test-session-123',
  //   });
  //   await em.persistAndFlush(fakeSchedule);

  //   // Create schedule job linked to the schedule
  //   const fakeJob = em.create(ScheduleJob, {
  //     schedule: fakeSchedule,
  //     campaignId: 'test-campaign-123',
  //     profileId: 12345,
  //     region: 'na',
  //     executeAt: new Date(),
  //     jobType: 'slot_start',
  //     action: 'ENABLE',
  //     status: 'pending',
  //   });
  //   await em.persist(fakeJob).flush();

  //   // Add to BullMQ queue with 1 retry for quick testing
  //   await this.schedulerQueue.add('execute', { jobId: fakeJob.id }, {
  //     delay: 0,
  //     attempts: 1,
  //     backoff: { type: 'fixed', delay: 1000 },
  //   });

  //   return { message: 'Test job queued', jobId: fakeJob.id, scheduleId: fakeSchedule.id };
  // }

  // @Post('test-update-status')
  // async testUpdateStatus(
  //   @Body()
  //   body: {
  //     campaignId: string;
  //     profileId: number;
  //     region: 'na' | 'eu' | 'fe';
  //     state: 'ENABLED' | 'PAUSED';
  //     // Optional: pass a specific access token, or we'll fetch from DB
  //     accessToken?: string;
  //   },
  // ) {
  //   const { campaignId, profileId, region, state, accessToken: providedToken } = body;

  //   let accessToken = providedToken;

  //   console.log(`[TEST] Calling Amazon API: ${state} campaign ${campaignId}`);
  //   console.log(`[TEST] Profile: ${profileId}, Region: ${region}`);

  //   try {
  //     const result = await this.amazonClient.updateCampaign(
  //       accessToken as string,
  //       profileId,
  //       region,
  //       campaignId,
  //       { state },
  //     );

  //     console.log(`[TEST] Amazon response:`, JSON.stringify(result, null, 2));

  //     return {
  //       success: true,
  //       campaignId,
  //       requestedState: state,
  //       amazonResponse: result,
  //     };
  //   } catch (error: any) {
  //     console.error(`[TEST] Amazon API failed:`, error);
  //     throw new BadRequestException(
  //       {
  //         success: false,
  //         campaignId,
  //         requestedState: state,
  //         error: error?.response?.data || error.message,
  //         status: error?.response?.status,
  //       },
  //       error.status || 500,
  //     );
  //   }
  // }
}