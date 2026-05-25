import { ScheduleAction } from "src/common/enum/campaign.enum";

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