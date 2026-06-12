import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { InvitedUser } from 'src/entities/invited-user.entity';
import { EmailService } from 'src/modules/email/service/email.service';
import { SendInviteDto } from '../dto/send-invite.dto';
import { SessionData } from 'src/modules/session/service/session.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class UserService {
  constructor(
    private readonly em: EntityManager,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService
  ) {}

  async sendInvite(dto: SendInviteDto, session: SessionData) {
    const { email, name, companyName } = dto;

    const existingInvite = await this.em.findOne(InvitedUser, { email });

    if (existingInvite) {
      // Already logged in — fully onboarded, no re-invite allowed
      if (existingInvite.hasLoggedIn) {
        throw new ConflictException(`User with email ${email} has already joined the platform.`);
      }

      // Not logged in yet — resend invite email, update name if provided
      if (name) {
        existingInvite.name = name;
        await this.em.flush();
      }

      this.emailService.sendInviteUserEmail({
        to: email,
        subject: "You're Invited",
        template: 'user-invited',
        context: {
          name: existingInvite.name || email,
          companyName: companyName || 'our platform',
          inviteUrl: this.configService.getOrThrow("INVITE_URL")
        },
      });

      return {
        message: 'Invitation resent successfully',
        invitedUser: existingInvite,
      };
    }

    // First time invite — create new record
    const invitedUser = this.em.create(InvitedUser, {
      email,
      name: name || null,
      invitedBy: String(session.profileId)
    });

    await this.em.persist(invitedUser).flush();

    this.emailService.sendInviteUserEmail({
      to: email,
      subject: "You're Invited",
      template: 'user-invited',
      context: {
        name: name || email,
        companyName: companyName || 'our platform',
      },
    });

    return {
      message: 'Invitation sent successfully'
    };
  }
}