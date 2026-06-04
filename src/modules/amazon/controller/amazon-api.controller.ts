import {
  Controller,
  Get,
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
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AmazonRateLimitGuard } from 'src/guards/amazon-rate-limit.gurad';
import { SessionAuthGuard } from 'src/guards/SessionAuth.guard';
import { SessionService } from 'src/modules/session/service/session.service';
import { AmazonApiService } from '../amazon-api.service';
import { SESSION_COOKIE } from 'src/common/constants/session.constant';
import { AmazonSPCampaignResponse } from '../client/amazon-api.client';

@ApiTags('Amazon Advertising API')
@Controller('amazon')
export class AmazonApiController {
  constructor(
    private readonly amazonService: AmazonApiService,
    private readonly sessionService: SessionService,
  ) {}

  @Get('profiles')
  @UseGuards(SessionAuthGuard)
  @ApiCookieAuth('sid')
  @ApiOperation({ summary: 'List Amazon Advertising profiles' })
  async getProfiles(
    @Req() req: Request,
    @Query('region') region: 'na' | 'eu' | 'fe' = 'na',
  ) {
    const sessionId = req.cookies?.[SESSION_COOKIE];
    const session = await this.sessionService.get(sessionId);
    if (!session?.access_token) throw new UnauthorizedException('No Amazon token');
    return this.amazonService.getProfiles(session.access_token, region);
  }
}