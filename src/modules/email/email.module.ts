import { Module } from "@nestjs/common";
import { MailConfigModule } from "../mail/mail.config";
import { EmailListener } from "./listener/email.listener";
import { EmailService } from "./service/email.service";
import { MailWarmUpService } from "./service/mail-warmup.service";
import { EventEmitterModule } from "@nestjs/event-emitter";

@Module({
    imports: [EventEmitterModule.forRoot(), MailConfigModule],
    controllers: [],
    providers: [EmailService, EmailListener, MailWarmUpService],
    exports: [EmailService]
})

export class EmailModule {}