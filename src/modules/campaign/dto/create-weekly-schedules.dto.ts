// create-weekly-schedules.dto.ts
import { IsEnum, IsArray, ValidateNested, IsString } from 'class-validator';
import { Type } from 'class-transformer';

class TimeSlotDto {
  @IsString()
  startTime!: string; // "HH:mm"

  @IsString()
  endTime!: string;   // "HH:mm"
}

export class CreateWeeklySchedulesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyScheduleDto)
  schedules!: WeeklyScheduleDto[];
}

class WeeklyScheduleDto {
  @IsEnum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"])
  dayOfWeek!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeSlotDto)
  timeSlots!: TimeSlotDto[];

  @IsEnum(["ENABLED", "PAUSED"])
  action!: "ENABLED" | "PAUSED";
}