import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SendInviteDto } from '../dto/send-invite.dto';
import { UserService } from '../service/user.service';
import { AdminGuard } from 'src/guards/admin.guard';
import { SESSION_COOKIE } from 'src/common/constants/session.constant';
import type { Request } from 'express';
import { SessionData, SessionService } from 'src/modules/session/service/session.service';


@ApiTags('User')
@ApiBearerAuth()
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService, private readonly sessionService: SessionService) {}

  @Post('invite')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send or resend invitation email to a user' })
  @ApiResponse({ status: 200, description: 'Invitation sent or resent successfully' })
  @ApiResponse({ status: 409, description: 'User already joined the platform' })
  async sendInvite(@Req() req: Request, @Body() dto: SendInviteDto) {
    const sessionId = req.cookies[SESSION_COOKIE];
    const session = await this.sessionService.get(sessionId) as SessionData;
    return this.userService.sendInvite(dto, session);
  }
}