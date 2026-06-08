// src/modules/campaign-scheduler/dto/create-schedules.dto.ts
import { IsArray, IsString, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class TimeSlotDTO {
  @IsString()
  startTime!: string; // "HH:mm"

  @IsString()
  endTime!: string; // "HH:mm"
}

export class ScheduleConfigDTO {
  @IsString()
  scheduleDate!: string; // "yyyyMMdd"

  @IsOptional()
  @IsString()
  endDate?: string; // "yyyyMMdd" - for multi-day ranges

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeSlotDTO)
  timeSlots!: TimeSlotDTO[];

  @IsString()
  action!: 'ENABLED' | 'PAUSED';
}

export class CreateSchedulesDTO {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleConfigDTO)
  schedules!: ScheduleConfigDTO[];
}