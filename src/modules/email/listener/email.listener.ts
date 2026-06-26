import { MailerService } from "@nestjs-modules/mailer";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { EmailTemplate } from "../../../type/email";

@Injectable()
export class EmailListener {
    private logger = new Logger(EmailListener.name);
    
    constructor(private readonly mailService: MailerService) {}

    @OnEvent("user.invited")
    async handleEmail(payload: EmailTemplate) {
        try {
            const { template, ...otherConfigurations } = payload;
            const mailConfiguration = { ...otherConfigurations };
            if (template) mailConfiguration["template"] = template;

            await this.mailService.sendMail(mailConfiguration);
        } catch (error: any) {
            this.logger.error('[EmailListener] user.invited failed (non-blocking):', error.message);
        }
    }

    @OnEvent("job.failed")
    async handleFailedJobEmail(payload: EmailTemplate) {
        try {
            const { template, ...otherConfigurations } = payload;
            const mailConfiguration = { ...otherConfigurations };
            if (template) mailConfiguration["template"] = template;

            await this.mailService.sendMail(mailConfiguration);
        } catch (error: any) {
            this.logger.error('[EmailListener] job.failed failed (non-blocking):', error.message);
        }
    }
}