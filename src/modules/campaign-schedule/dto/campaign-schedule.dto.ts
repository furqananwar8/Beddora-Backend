import { ScheduleAction } from "src/common/enum/campaign.enum";
import { IsArray, IsEnum, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ScheduleSlotDto } from "./campaign-schedule-slot.dto";

export class TimeSlotDto {
  startTime!: string; // "10:00"
  endTime!: string;   // "12:00"
}

export class CreateScheduleDto {
  scheduleDate!: string;   // "20260525"
  endDate?: string;       // "20260531"
  timeSlots!: TimeSlotDto[];
  timezone!: string;
  action!: ScheduleAction;
  bidAdjustment?: number;
}

export class CreateCampaignScheduleDto {
  @IsString()
  scheduleDate!: string; // yyyy-MM-DD

  @IsOptional()
  @IsString()
  endDate?: string;      // accepts yyyyMMdd or yyyy-MM-dd

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleSlotDto)
  timeSlots!: ScheduleSlotDto[];

  @IsString()
  timezone!: string;   // e.g. America/New_York

  @IsEnum(ScheduleAction)
  action!: ScheduleAction;
}

export class BulkScheduleDto {
  schedules!: CreateCampaignScheduleDto[];
}