import { MailerModule } from "@nestjs-modules/mailer";
import { PugAdapter } from "@nestjs-modules/mailer/adapters/pug.adapter";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { join } from "path";

const isDev = process.env.NODE_ENV !== "production";

@Module({
  imports: [
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // ── DEBUG: Log all env vars ──
        const user = config.get('MAIL_USERNAME');
        const pass = config.get('MAIL_PASSWORD');
        
        console.log('=== MAILER CONFIG DEBUG ===');
        console.log('MAIL_USERNAME:', user ? `***${user.slice(-10)}` : 'UNDEFINED');
        console.log('MAIL_PASSWORD:', pass ? `***${pass.slice(-4)}` : 'UNDEFINED');
        console.log('NODE_ENV:', process.env.NODE_ENV);
        console.log('All env keys:', Object.keys(process.env).filter(k => k.includes('MAIL')));
        console.log('===========================');

        return {
          transport: {
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            pool: true,
            maxConnections: 5,
            auth: { user, pass },
            dnsTimeout: 300,
          logger: isDev,
          debug: isDev,
          },
          defaults: {
            from: '"Beddora Dayparting" <info@dayparting.beddora.com>'
          },
          template: {
            dir: join(__dirname, '..', 'email', 'templates'),
            adapter: new PugAdapter(),
            options: { strict: true }
          }
        };
      },
    }),
  ],
  exports: [MailerModule]
})
export class MailConfigModule {}