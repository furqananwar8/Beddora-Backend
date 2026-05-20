import { Module, Global } from '@nestjs/common';
import { SessionService } from './service/session.service';

@Global() // makes SessionService available app-wide without re-importing
@Module({
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}