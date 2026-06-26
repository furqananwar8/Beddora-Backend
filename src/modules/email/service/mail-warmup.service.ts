import { MailerService } from "@nestjs-modules/mailer";
import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";

@Injectable()
export class MailWarmUpService implements OnApplicationBootstrap {
    private logger = new Logger(MailWarmUpService.name)

    constructor(private readonly mailerService: MailerService) {}
    
    async onApplicationBootstrap() {
        try {
            const transporter = (this.mailerService as any)?.transporter;
            if (!transporter) {
                this.logger.warn('[MailWarmUp] No transporter found. Email disabled.');
                return;
            }

            transporter.on('error', (err: Error) => {
                this.logger.error('[MailWarmUp] Pool error (suppressed):', err.message);
            });

            await transporter.verify();
            this.logger.log('SMTP connection warmed up ✅');

        } catch (err: any) {
            this.logger.error('SMTP warmup failed ❌', err.message);
        }
    }
}