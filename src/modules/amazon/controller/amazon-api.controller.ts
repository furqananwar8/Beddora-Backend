import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AmazonRateLimitGuard } from 'src/guards/amazon-rate-limit.gurad';
import { AmazonApiService, AmazonSPCampaignResponse } from '../amazon-api.service';


@ApiTags('Amazon Advertising API')
@Controller('amazon')
export class AmazonApiController {
  constructor(private readonly amazonService: AmazonApiService) {}

  @Get('v2/sp/campaigns')
  @UseGuards(AmazonRateLimitGuard)
  @ApiOperation({
    summary: 'List SP Campaigns',
    description: 'GET /v2/sp/campaigns clone with nextToken pagination.',
  })
  @ApiQuery({ name: 'nextToken', required: false, description: 'Pagination cursor from previous response' })
  @ApiQuery({ name: 'count', required: false, description: 'Page size (1–100). Default 100.' })
  @ApiQuery({ name: 'profileId', required: false, description: 'Amazon Advertising profile ID' })
  @ApiResponse({ status: 200, description: 'Paginated list of SP campaigns' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded — x-amzn-RateLimit-* headers included' })
  async getSPCampaigns(
    @Query('nextToken') nextToken?: string,
    @Query('count') count?: string,
    @Query('profileId') profileId?: string,
  ): Promise<AmazonSPCampaignResponse> {
    return this.amazonService.getCampaigns(
      nextToken,
      count ? parseInt(count, 10) : 100,
      profileId ? parseInt(profileId, 10) : undefined,
    );
  }
}