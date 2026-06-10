// create-schedules.dto.ts
import { IsArray, IsString, IsIn, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class TimeSlotDto {
  @IsString()
  startTime!: string; // "HH:mm"

  @IsString()
  endTime!: string;   // "HH:mm"
}

export class ScheduleConfigDto {
  @IsIn([0, 1, 2, 3, 4, 5, 6])
  dayOfWeek!: number; // 0=Sun, 1=Mon, ..., 6=Sat

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeSlotDto)
  timeSlots!: TimeSlotDto[];

  @IsIn(['ENABLED', 'PAUSED'])
  action!: 'ENABLED' | 'PAUSED';
}

export class CreateSchedulesDTO {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleConfigDto)
  schedules!: ScheduleConfigDto[];
}