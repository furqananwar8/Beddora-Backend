import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { JobAlertService } from './service/alert.service';
@Module({
  imports: [EmailModule],
  providers: [JobAlertService],
  exports: [JobAlertService],
})
export class AlertModule {}