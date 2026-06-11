import { Injectable, HttpException, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { ConfigService } from '@nestjs/config';
import { AmazonProfile } from 'src/guards/SessionAuth.guard';
import { decodeCursor, encodeCursor } from 'src/utils/amazon-pagination-cursor';

interface QueryCampaignsForProfileOptions {
  accessToken: string;
  profile: AmazonProfile;
  type: AmazonAdProduct;
  maxResults: number;
  state?: string;
  nextToken?: string;
}

export interface QueryCampaignsOptions {
  accessToken: string;
  profiles: AmazonProfile[];
  type: AmazonAdProduct;
  page?: number | null;
  limit?: number;
  search?: string;
  state?: string;
}

export type AmazonAdProduct = 
  | 'SPONSORED_PRODUCTS' 
  | 'SPONSORED_BRANDS' 
  | 'SPONSORED_DISPLAY';

export type AmazonRegion = 'na' | 'eu' | 'fe';

export interface QueryCampaignsOptions {
  accessToken: string;
  profileId: number;
  region?: AmazonRegion;
  type: AmazonAdProduct;
  page?: number | null;
  limit?: number;
  search?: string;
  state?: string;
}

export interface CampaignListResult {
  data: any[];
  meta: {
    total: number;
    page: number | null;
    limit: number;
    totalPages?: number;
    hasNextPage: boolean;
    nextCursor: string | null;
  };
}

export type AmazonCampaignState =
  | 'ENABLED'
  | 'PAUSED'
  | 'ARCHIVED';

export interface QueryCampaignsOptions {
  nextToken?: string;
  maxResults?: number;
  stateFilter?: AmazonCampaignState | AmazonCampaignState[];
  adProducts?: AmazonAdProduct[];
  campaignIds?: string[];
  portfolioIds?: string[];
  nameFilter?: string[];
}

export interface AmazonCampaign {
  campaignId: string;
  name: string;
  state: AmazonCampaignState;
  adProduct: AmazonAdProduct;
  portfolioId?: string;
  creationDateTime?: string;
  // extend as needed
}

export interface AmazonSPCampaignResponse {
  campaigns: AmazonCampaign[];
  nextToken?: string;
}


@Injectable()
export class AmazonCampaignApiClient {
  private readonly baseUrls = {
    na: 'https://advertising-api.amazon.com',
    eu: 'https://advertising-api-eu.amazon.com',
    fe: 'https://advertising-api-fe.amazon.com',
  };

  private readonly logger = new Logger(AmazonCampaignApiClient.name);

  constructor(private readonly httpService: HttpService, private readonly configService: ConfigService) {
    // REQUEST interceptor
    this.httpService.axiosRef.interceptors.request.use(
      (config) => {
        this.logger.debug(`HTTP REQUEST\n${JSON.stringify({
          method: config.method?.toUpperCase(),
          url: config.url,
          headers: {
            ...config.headers,
            Authorization: config.headers?.Authorization
              ? `${(config.headers.Authorization as string).substring(0, 30)}...`
              : undefined,
          },
          body: config.data,
        }, null, 2)}`);
        return config;
      },
      (error) => {
        this.logger.error(`HTTP REQUEST ERROR\n${JSON.stringify({
          message: error.message,
          config: {
            method: error.config?.method?.toUpperCase(),
            url: error.config?.url,
          },
        }, null, 2)}`);
        return Promise.reject(error);
      },
    );

    // RESPONSE interceptor
    this.httpService.axiosRef.interceptors.response.use(
      (response) => {
        this.logger.debug(`HTTP RESPONSE\n${JSON.stringify({
          status: response.status,
          statusText: response.statusText,
          url: response.config?.url,
          method: response.config?.method?.toUpperCase(),
          data: response.data,
        }, null, 2)}`);
        return response;
      },
      (error: AxiosError) => {
        this.logger.error(`HTTP RESPONSE ERROR\n${JSON.stringify({
          message: error.message,
          status: error.response?.status,
          statusText: error.response?.statusText,
          url: error.config?.url,
          method: error.config?.method?.toUpperCase(),
          responseData: error.response?.data,
        }, null, 2)}`);
        return Promise.reject(error);
      },
    );
  }

  private getBaseUrl(region: 'na' | 'eu' | 'fe' = 'na') {
    return this.baseUrls[region];
  }

  async getProfiles(accessToken: string, region: 'na' | 'eu' | 'fe' = 'na') {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get(`${this.getBaseUrl(region)}/profiles`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      return data as Array<{
        profileId: number;
        countryCode: string;
        currencyCode: string;
        timezone: string;
        accountInfo: { id: string; type: string; name?: string };
      }>;
    } catch (err) {
      const error = err as AxiosError;
      throw new HttpException(error.response?.data || 'Profile fetch failed', error.response?.status || 500);
    }
  }

//Currently in use
 async queryCampaignsForProfile(
  options: QueryCampaignsForProfileOptions,
): Promise<{ campaigns: any[]; nextToken: string | null | undefined }> {
  const { accessToken, profile, type, maxResults, state, nextToken } = options;

  const clientId = this.configService.getOrThrow('AMAZON_CLIENT_ID');
  const campaigns: any[] = [];
  let token = nextToken;
  let hasMore = true;

  while (campaigns.length < maxResults && hasMore) {
    const body: any = {
      maxResults: Math.min(500, maxResults - campaigns.length),
      adProductFilter: { include: [type] },
    };
    if (state) body.stateFilter = { include: [state.toUpperCase()] };
    if (token) body.nextToken = token;

    const { data } = await firstValueFrom(
      this.httpService.post(
        `${this.getBaseUrl(profile.region as AmazonRegion)}/adsApi/v1/query/campaigns`,
        body,
        {
          headers: {
            Authorization: `Bearer ${accessToken.trim()}`,
            'Amazon-Ads-ClientId': String(clientId),
            'Amazon-Advertising-API-Scope': String(profile.profileId),
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const pageCampaigns = data?.campaigns || [];
    campaigns.push(...pageCampaigns);

    token = data?.nextToken || null;
    hasMore = !!token && pageCampaigns.length > 0;
  }

  return { campaigns, nextToken: token };
}


async queryCampaignsByType(
  options: QueryCampaignsOptions & { cursor?: string | null }
): Promise<CampaignListResult> {
  const { accessToken, profiles, type, limit = 15, search, state, cursor } = options;

  // Decode cursor — keys are STRINGS because JSON
  const cursors: Record<string, string | null> = cursor ? decodeCursor(cursor) : {};
   const perProfileLimit = search ? 500 : Math.ceil(limit / profiles.length);

  // Fetch from ALL profiles in parallel
  const results = await Promise.all(
    profiles.map(async (profile) => {
      // BUG FIX: Use String(profileId) as key
      const profileToken = cursors[String(profile.profileId)] || undefined;
      const { campaigns, nextToken } = await this.queryCampaignsForProfile({
        accessToken,
        profile,
        type,
        maxResults: perProfileLimit,
        state,
        nextToken: profileToken,
      });

      return {
        profileId: profile.profileId,
        countryCode: profile.countryCode,
        campaigns,
        nextToken,
      };
    }),
  );

  // Merge all accounts
  let campaigns = results.flatMap((r) =>
    r.campaigns.map((c: any) => ({
      ...c,
      countryCode: r.countryCode,
      profileId: r.profileId,
    }))
  );

  // Sort newest first
  campaigns.sort((a, b) => Date.parse(b.creationDateTime) - Date.parse(a.creationDateTime));

  // Search filter
  if (search) {
    const term = search.toUpperCase().trim();
    campaigns = campaigns.filter((c) => {
      const nameMatch = c.name?.toUpperCase().includes(term);
      const idMatch = c.campaignId?.toUpperCase().includes(term);
      const skuMatch = c.tags?.some((t: string) => t.toUpperCase().includes(term));
      return nameMatch || idMatch || skuMatch;
    });
  }

  // Build next cursor from profiles that still have more data
  const nextCursors: Record<string, string | null> = {};
  let hasNext = false;
  for (const r of results) {
    if (r.nextToken) {
      nextCursors[String(r.profileId)] = r.nextToken;
      hasNext = true;
    }
  }

  return {
    data: campaigns,
    meta: {
      total: campaigns.length,
      page: null,
      limit,
      hasNextPage: hasNext,
      nextCursor: hasNext ? encodeCursor(nextCursors) : null,
    },
  };
}


 async updateCampaign(
  accessToken: string,
  profileId: number,
  region: 'na' | 'eu' | 'fe',
  campaignId: string,
  payload: { state?: string; bidding?: any; name?: string; startDateTime?: string; endDateTime?: string; portfolioId?: string | null },
) {
  try {
    const clientId = this.configService.getOrThrow('AMAZON_CLIENT_ID');

    const { data } = await firstValueFrom(
      this.httpService.post(
        `${this.getBaseUrl(region)}/adsApi/v1/update/campaigns`,
        {
          campaigns: [
            {
              campaignId,
              ...payload,
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Amazon-Ads-ClientId': String(clientId),
            'Amazon-Advertising-API-Scope': String(profileId),
            'Content-Type': 'application/json',
          },
        },
      ),
    );
    return data;
  } catch (err) {
    const error = err as AxiosError;
    throw new HttpException(
      error.response?.data || 'Campaign update failed',
      error.response?.status || 500,
    );
  }
}
}