
import { IsString } from 'class-validator';

export class ScheduleSlotDto {
  @IsString()
  startTime!: string; // HH:mm

  @IsString()
  endTime!: string;   // HH:mm
}