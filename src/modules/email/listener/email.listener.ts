import { MailerService } from "@nestjs-modules/mailer";
import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { EmailTemplate } from "../../../type/email";


@Injectable()
export class EmailListener {
    constructor(private readonly mailService: MailerService) {}

    @OnEvent("user.invited")
    async handleEmail(payload: EmailTemplate) {
        const { template, ...otherConfigurations } = payload;
        const mailConfiguration = {
            ...otherConfigurations
        }

        if(template) mailConfiguration["template"] = template;

        await this.mailService.sendMail(mailConfiguration)
    }

    @OnEvent("job.failed")
    async handleFailedJobEmail(payload: EmailTemplate) {
        const { template, ...otherConfigurations } = payload;
        const mailConfiguration = {
            ...otherConfigurations
        }

        if(template) mailConfiguration["template"] = template;

        await this.mailService.sendMail(mailConfiguration)
    }
}