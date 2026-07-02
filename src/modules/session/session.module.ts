import { Module, Global } from '@nestjs/common';
import { SessionService } from './service/session.service';
import { RedisModule } from 'src/redis/redis.module';
import { ProfileTokenService } from './service/profile-token.service';

@Global() // makes SessionService available app-wide without re-importing
@Module({
  imports: [RedisModule],
  providers: [SessionService,  ProfileTokenService,],
  exports: [SessionService,  ProfileTokenService,],
})
export class SessionModule {}