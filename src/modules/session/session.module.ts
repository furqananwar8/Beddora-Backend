import { Module, Global } from '@nestjs/common';
import { SessionService } from './service/session.service';
import { RedisModule } from 'src/redis/redis.module';

@Global() // makes SessionService available app-wide without re-importing
@Module({
  imports: [RedisModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}