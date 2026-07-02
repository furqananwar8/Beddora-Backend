import { Module } from '@nestjs/common';
import { JobAlertService } from './service/alert.service';

@Module({
  providers: [JobAlertService],
  exports: [JobAlertService],
})
export class AlertModule {}