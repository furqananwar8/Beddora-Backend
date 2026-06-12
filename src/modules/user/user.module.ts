import { Module } from '@nestjs/common';

import { EmailModule } from '../email/email.module'; // adjust path as needed
import { UserController } from './controller/user.controller';
import { UserService } from './service/user.service';

@Module({
  imports: [EmailModule], // <-- add this
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}