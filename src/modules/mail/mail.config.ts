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
      useFactory: (config: ConfigService) => ({
        transport: {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          pool: true,
          maxConnections: 5,
          dnsTimeout: 300,
          auth: {
            user: config.get('MAIL_USERNAME'),
            pass: config.get('MAIL_PASSWORD'),
          },
          logger: isDev,
          debug: isDev,
        },
        defaults: {
          from: '"Beddora Dayparting" <info@dayparting.beddora.com>'
        },
        template: {
          dir: join(__dirname, '..', 'email', 'templates'),
          adapter: new PugAdapter(),
          options: {
            strict: true
          }
        }
      }),
    }),
  ],
  exports: [MailerModule]
})
export class MailConfigModule {}