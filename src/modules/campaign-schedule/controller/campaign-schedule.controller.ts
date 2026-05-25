// src/campaign-schedule/campaign-schedule.controller.ts
import { Controller, Post, Delete, Body, Sse, Param, ParseIntPipe } from '@nestjs/common';
import { CampaignScheduleService } from '../service/campaign-schedule.service';
import { Observable } from 'rxjs';
import { ScheduleEventsService } from '../schedule-events.service';
import { CreateCampaignScheduleDto } from '../dto/campaign-schedule.dto';

@Controller('campaign-schedules')
export class CampaignScheduleController {
  constructor(
    private readonly service: CampaignScheduleService,
    private readonly scheduleEvents: ScheduleEventsService,
  ) {}

  /**
   * POST /api/v1/campaign-schedules/:campaignId/schedule
   */
  @Post(':campaignId/schedule')
  async schedule(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() dto: CreateCampaignScheduleDto,
  ) {
    return this.service.schedule(campaignId, dto);
  }

  /**
   * DELETE /api/v1/campaign-schedules/:campaignId
   */
  @Delete(':campaignId')
  async unschedule(
    @Param('campaignId', ParseIntPipe) campaignId: number,
  ) {
    return this.service.unschedule(campaignId);
  }

  @Sse('events')
  events(): Observable<{ data: any }> {
    return this.scheduleEvents.getEvents();
  }
}