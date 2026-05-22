import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  const allowedOrigins = configService.get<string>('CORS_ORIGINS')?.split(',') ?? [];

  app.enableCors({
    origin: (origin: string, callback: (error?: Error | null, val?: boolean | null) => void) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.use(cookieParser());

  app.setGlobalPrefix("/api/")
  
  const config = new DocumentBuilder()
  .setTitle('Amazon Ads API')
  .setDescription('Amazon OAuth + Ads API integration')
  .setVersion('1.0')
  .addCookieAuth('sid') // ← matches the string passed to @ApiCookieAuth
  .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document); // → http://localhost:3000/api/docs

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
