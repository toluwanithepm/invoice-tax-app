import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { env } from './config/env';

/** Shared by main.ts, the Vercel entry and the e2e tests, so all three run the same security setup. */
export function configureApp(app: NestExpressApplication) {
  app.set('trust proxy', 1); // Vercel / Supabase edge: the client IP is in X-Forwarded-For
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  // The web app reaches the API through a same-origin rewrite, so CORS stays closed.
  app.enableCors({ origin: false });
  app.enableShutdownHooks();
  if (env().NODE_ENV === 'development') {
    const doc = SwaggerModule.createDocument(
      app as unknown as INestApplication,
      new DocumentBuilder().setTitle('E-Invoice API').setVersion('1').addCookieAuth('sid').build(),
    );
    SwaggerModule.setup('v1/docs', app as unknown as INestApplication, doc);
  }
  return app;
}

export async function createApp() {
  env(); // fail fast on bad configuration
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false, rawBody: true });
  app.useLogger(app.get(Logger));
  return configureApp(app);
}
