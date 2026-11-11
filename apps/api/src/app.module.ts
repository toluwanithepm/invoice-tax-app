import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { env } from './config/env';
import { PrismaModule } from './prisma/prisma.service';
import { ProblemFilter } from './common/problem.filter';
import { runWithContext } from './common/request-context';
import { RateLimitGuard, RateLimitService } from './platform/rate-limit';
import { AuditService } from './platform/audit.service';
import { NotificationsService } from './platform/notifications.service';
import { SessionService } from './auth/session.service';
import { CsrfGuard, SessionGuard } from './auth/guards';
import { AuthService } from './auth/auth.service';
import { AuthController, MeController } from './auth/auth.controller';
import { WorkspaceGuard } from './tenancy/workspace.guard';
import { ACCESS_POINT, TAX_ID_REGISTRY } from './access-point/access-point';
import { MockAccessPoint, MockTaxIdRegistry } from './access-point/mock-access-point';
import { WorkspacesService } from './workspaces/workspaces.service';
import { WorkspacesController } from './workspaces/workspaces.controller';
import { MembersService } from './members/members.service';
import { InvitationsController, MembersController } from './members/members.controller';
import { CustomersService } from './customers/customers.service';
import { CustomersController, TinLookupController } from './customers/customers.controller';
import { ProductsController, ProductsService } from './products/products';
import { ImportsController, ImportsService, ImportTemplatesController } from './imports/imports';
import { InvoicesService } from './invoices/invoices.service';
import { InvoicesController } from './invoices/invoices.controller';
import { ClearanceService } from './clearance/clearance.service';
import { PdfService } from './documents/pdf.service';
import { SharingService } from './sharing/sharing.service';
import { PublicInvoicesController } from './sharing/public.controller';
import { JobsService } from './jobs/jobs.service';
import { DevController, HealthController, InternalJobsController } from './jobs/internal.controller';

/** Wraps each request in an AsyncLocalStorage context (request id, IP) used by logging, audit and RLS. */
function contextMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  runWithContext({ requestId, ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null }, () => next());
}

@Global()
@Module({
  providers: [RateLimitService, AuditService, NotificationsService, JobsService],
  exports: [RateLimitService, AuditService, NotificationsService, JobsService],
})
class PlatformModule {}

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env().NODE_ENV === 'test' ? 'silent' : env().LOG_LEVEL,
        genReqId: (req) => (req as Request).res?.getHeader('X-Request-Id')?.toString() ?? randomUUID(),
        transport: env().NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        // Never log secrets or personal data (NFR-9).
        redact: {
          paths: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.headers["x-csrf-token"]',
            'res.headers["set-cookie"]',
            'req.body.code',
            'req.body.identifier',
            'req.body.bankAccountNumber',
          ],
          censor: '[redacted]',
        },
        autoLogging: { ignore: (req) => req.url === '/v1/health' },
      },
    }),
    PrismaModule,
    PlatformModule,
  ],
  controllers: [
    AuthController,
    MeController,
    WorkspacesController,
    MembersController,
    InvitationsController,
    CustomersController,
    TinLookupController,
    ProductsController,
    ImportsController,
    ImportTemplatesController,
    InvoicesController,
    PublicInvoicesController,
    InternalJobsController,
    HealthController,
    DevController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    // Order matters: CSRF → session → workspace membership/permission → rate limit.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: WorkspaceGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: ACCESS_POINT, useClass: MockAccessPoint },
    { provide: TAX_ID_REGISTRY, useClass: MockTaxIdRegistry },
    SessionService,
    AuthService,
    WorkspacesService,
    MembersService,
    CustomersService,
    ProductsService,
    ImportsService,
    InvoicesService,
    ClearanceService,
    PdfService,
    SharingService,
  ],
})
export class AppModule implements NestModule {
  constructor(jobs: JobsService, notifications: NotificationsService, limiter: RateLimitService) {
    let last = 0;
    jobs.registerMaintenance(async () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      await notifications.retryPending();
      await limiter.purgeOlderThan(24);
    });
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(contextMiddleware).forRoutes('*');
  }
}
