import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateCampaignScheduleDto } from './campaign-schedule.dto';


export class SyncCampaignScheduleDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCampaignScheduleDto)
  schedules!: CreateCampaignScheduleDto[];
}