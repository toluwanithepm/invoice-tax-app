import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  billingSettingsSchema,
  checkoutSchema,
  paymentReferenceSchema,
  type BillingSettings,
  type CheckoutInput,
} from '@einv/shared';
import { Public, RateLimit, RequirePermission, SkipCsrf } from '../common/decorators';
import { unauthorized } from '../common/errors';
import { ZodPipe } from '../common/zod';
import { isProd } from '../config/env';
import { BillingService } from './billing.service';
import { MockPaymentProvider, PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider';

@Controller('v1/workspaces/:workspaceId/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Every member can see the plan and usage (the usage meter shows on Home). */
  @Get()
  @RequirePermission('workspace.view')
  summary() {
    return this.billing.summary();
  }

  @Get('payments')
  @RequirePermission('billing.view')
  payments() {
    return this.billing.payments();
  }

  @Get('payments/:paymentId/receipt.pdf')
  @RequirePermission('billing.view')
  async receipt(@Param('paymentId', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { filename, pdf } = await this.billing.receiptPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '')}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  }

  @Post('checkout')
  @RequirePermission('billing.manage')
  @RateLimit({ name: 'billing-checkout', limit: 20, windowSec: 600, by: 'user' })
  checkout(@Body(new ZodPipe(checkoutSchema)) body: CheckoutInput) {
    return this.billing.checkout(body);
  }

  @Post('confirm')
  @HttpCode(200)
  @RequirePermission('billing.view')
  confirm(@Body(new ZodPipe(paymentReferenceSchema)) body: { reference: string }) {
    return this.billing.confirm(body.reference);
  }

  @Patch()
  @RequirePermission('billing.manage')
  settings(@Body(new ZodPipe(billingSettingsSchema)) body: BillingSettings) {
    return this.billing.updateSettings(body);
  }

  @Delete('scheduled-change')
  @RequirePermission('billing.manage')
  cancelScheduled() {
    return this.billing.cancelScheduledChange();
  }
}

/** Paystack calls this; the signature is checked over the raw body and the result re-verified with Paystack. */
@Controller('v1/webhooks')
@Public()
@SkipCsrf()
export class PaymentWebhookController {
  constructor(
    private readonly billing: BillingService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  @Post('paystack')
  @HttpCode(200)
  @RateLimit({ name: 'payment-webhook', limit: 600, windowSec: 60, by: 'ip' })
  async paystack(@Req() req: RawBodyRequest<Request>, @Headers('x-paystack-signature') signature?: string) {
    if (!req.rawBody || !this.provider.verifyWebhook(req.rawBody, signature))
      throw unauthorized('Invalid signature.', 'BAD_SIGNATURE');
    const event = req.body as { event?: string; data?: { reference?: string } };
    const reference = event.data?.reference;
    if (
      (event.event === 'charge.success' || event.event === 'charge.failed') &&
      reference &&
      /^[A-Za-z0-9.=-]{8,64}$/.test(reference)
    ) {
      await this.billing.settleFromWebhook(reference);
    }
    return { received: true };
  }
}

/** Development only: the built-in test checkout finishes a mock payment. Absent in production. */
@Controller('v1/billing/test-checkout')
@Public()
export class TestCheckoutController {
  constructor(@Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider) {}

  @Post(':reference')
  @HttpCode(200)
  @RateLimit({ name: 'test-checkout', limit: 30, windowSec: 60, by: 'ip' })
  complete(
    @Param('reference', new ZodPipe(paymentReferenceSchema.shape.reference)) reference: string,
    @Body(
      new ZodPipe(
        z.object({
          outcome: z.enum(['success', 'failed']),
          channel: z.enum(['card', 'bank_transfer', 'ussd']).default('card'),
        }),
      ),
    )
    body: { outcome: 'success' | 'failed'; channel: string },
  ) {
    if (isProd() || this.provider.mode !== 'mock') throw new NotFoundException();
    if (!MockPaymentProvider.complete(reference, body.outcome, body.channel)) throw new NotFoundException();
    return { ok: true };
  }
}
