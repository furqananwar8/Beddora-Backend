import { MailerService } from "@nestjs-modules/mailer";
import { Injectable, OnApplicationBootstrap } from "@nestjs/common";


@Injectable()
export class MailWarmUpService implements OnApplicationBootstrap {
    constructor(private readonly mailerService: MailerService) {}
    
    async onApplicationBootstrap() {
        try{
            const transporter = (this.mailerService as any).transporter;
    
            await transporter.verify();
            
            console.log('SMTP connection warmed up ✅');

        } catch (err) {
            console.error('SMTP warmup failed ❌', err);
        }
    }
}