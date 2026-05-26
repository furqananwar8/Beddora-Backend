// src/campaign-schedule/campaign-schedule.controller.ts
import { Controller, Post, Delete, Body, Sse, Param, ParseIntPipe } from '@nestjs/common';
import { CampaignScheduleService } from '../service/campaign-schedule.service';
import { Observable, of, timer, concat } from 'rxjs';
import { concatMap, map, take } from 'rxjs/operators';
import { ScheduleEventsService } from '../schedule-events.service';
import { CreateCampaignScheduleDto } from '../dto/campaign-schedule.dto';
import { ScheduleAction } from 'src/common/enum/campaign.enum';

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

  /**
   * POST /api/v1/campaign-schedules/sync-now
   *
   * 1. Creates 3 fake campaigns in DB
   * 2. Queues a delayed BullMQ job for each one
   * 3. Streams SSE progress (completes in ~15-20s)
   */
  @Post('sync-now')
  @Sse()
  syncNow(): Observable<{ data: any }> {
    const totalStages = 3;
    const targetDurationMs = 15000;
    const gapMs = Math.max(3000, Math.floor(targetDurationMs / totalStages));

    // Store created campaigns between emissions (request-scoped)
    let fakeCampaigns: any[] = [];

    const stages$ = timer(0, gapMs).pipe(
      take(totalStages),
      concatMap(async (index) => {
        // Step 1: Create campaigns on first tick (before any SSE emission)
        if (index === 0) {
          fakeCampaigns = await this.service.createFakeCampaigns(totalStages);
        }

        const campaign = fakeCampaigns[index];
        const delaySeconds = 8 + index * 4; // 8s, 12s, 16s

        // Step 2: Schedule this campaign
        const schedule = await this.service.createFakeSchedule(
            campaign.campaignId,
            delaySeconds,
            ScheduleAction.ENABLE,
        );

        return {
          data: {
            stage: index + 1,
            totalStages,
            campaignId: campaign.id,
            campaignName: campaign.name,
            scheduleId: schedule.id,
            bullMqDelaySeconds: delaySeconds,
            message: `Campaign ${campaign.id} created & scheduled (${delaySeconds}s delay)`,
            progress: Math.round(((index + 1) / totalStages) * 100),
            timestamp: new Date().toISOString(),
          },
        };
      }),
    );

    const done$ = of({
      data: {
        done: true,
        totalScheduled: totalStages,
        message: `Fake sync complete — ${totalStages} campaigns created & scheduled`,
        timestamp: new Date().toISOString(),
      },
    });

    return concat(stages$, done$);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private intervalTimer(start: number, interval: number): Observable<number> {
    // Same as RxJS timer(start, interval) but explicit for clarity
    const { timer } = require('rxjs');
    return timer(start, interval);
  }

  private getStageMessage(index: number): string {
    const messages = [
      'Stage 1: Fetching campaigns from Amazon Ads...',
      'Stage 2: Processing bid adjustments and budgets...',
      'Stage 3: Finalizing sync and updating local state...',
    ];
    return messages[index] ?? 'Processing...';
  }
  
  @Sse('events')
  events(): Observable<{ data: any }> {
    return this.scheduleEvents.getEvents();
  }
}