import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AmazonSPCampaignResponse } from '../amazon-api.service';


@Injectable()
export class AmazonCampaignApiClient {
  private readonly baseUrl: string =
    process.env.AMAZON_API_BASE_URL || 'http://localhost:3000/amazon';

  constructor(private readonly httpService: HttpService) {}

  async getSPCampaignsPage(
    profileId: number,
    nextToken?: string,
    count: number = 100,
  ): Promise<AmazonSPCampaignResponse> {
    const params: Record<string, any> = { profileId, count };
    if (nextToken) params.nextToken = nextToken;

    const { data }: { data: any } = await firstValueFrom(
      this.httpService.get<AmazonSPCampaignResponse>(
        `${this.baseUrl}/v2/sp/campaigns`,
        { params },
      ),
    );

    return data;
  }

  async getAllSPCampaigns(profileId: number): Promise<AmazonSPCampaignResponse['campaigns']> {
    const allCampaigns: AmazonSPCampaignResponse['campaigns'] = [];
    let nextToken: string | undefined;

    do {
      const page = await this.getSPCampaignsPage(profileId, nextToken, 100);
      allCampaigns.push(...page.campaigns);
      nextToken = page.nextToken;
    } while (nextToken);

    return allCampaigns;
  }
}