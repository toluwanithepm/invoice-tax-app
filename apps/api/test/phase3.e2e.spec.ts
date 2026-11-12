import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac } from 'node:crypto';
import { priceKobo } from '@einv/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { BillingService, RENEW_JOB } from '../src/billing/billing.service';
import { MockPaymentProvider } from '../src/billing/payment-provider';
import { runWithContext } from '../src/common/request-context';
import { devInbox } from '../src/platform/notifications.service';
import { Client, createTestApp, randomEmail } from './helpers';

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const DAY = 86_400_000;

d('Phase 3 (e2e, real Postgres with RLS)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let billing: BillingService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    billing = app.get(BillingService);
  });
  afterAll(async () => {
    await app?.close();
  });
  afterEach(() => {
    MockPaymentProvider.declineRenewals = false;
  });

  /** Test-only shortcut to move a workspace through time. */
  const setWorkspace = (ws: string, data: Record<string, unknown>) =>
    prisma.scoped({ workspaceId: ws, userId: null }).workspace.update({ where: { id: ws }, data });

  async function pay(c: Client, ws: string, plan: string, interval: string, outcome: 'success' | 'failed' = 'success') {
    const co = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan, interval });
    expect(co.status).toBe(201);
    expect(co.body.authorizationUrl).toContain('/billing/test-checkout');
    expect((await c.post(`/v1/billing/test-checkout/${co.body.reference}`, { outcome })).status).toBe(200);
    const confirmed = await c.post(`/v1/workspaces/${ws}/billing/confirm`, { reference: co.body.reference });
    expect(confirmed.status).toBe(200);
    return { reference: co.body.reference as string, amount: co.body.amount as number, confirmed: confirmed.body };
  }

  const renewNow = (ws: string, periodEnd: Date, attempt = 0) =>
    runWithContext({ requestId: 'test', workspaceId: ws, userId: null }, () => billing.renew(periodEnd.toISOString(), attempt));

  describe('E10-1 trial and sending limits', () => {
    it('starts on a 14-day trial with 20 invoices, counts approved invoices, and pauses sending when the trial ends', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const s = await c.get(`/v1/workspaces/${ws}/billing`);
      expect(s.body).toMatchObject({ plan: 'trial', status: 'trialing', canSend: true, usage: { used: 0, limit: 20 } });
      const days = (new Date(s.body.trialEndsAt).getTime() - Date.now()) / DAY;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThanOrEqual(14);

      const { invoiceId } = await c.customerAndInvoice(ws);
      expect((await c.post(`/v1/workspaces/${ws}/invoices/${invoiceId}/submit`)).body.status).toBe('cleared');
      expect((await c.get(`/v1/workspaces/${ws}/billing`)).body.usage.used).toBe(1);

      await setWorkspace(ws, { trialEndsAt: new Date(Date.now() - 1000) });
      const ended = await c.get(`/v1/workspaces/${ws}/billing`);
      expect(ended.body).toMatchObject({ status: 'trial_ended', canSend: false, block: { code: 'TRIAL_ENDED' } });

      // Drafts still work; only sending to NRS waits.
      const { invoiceId: second } = await c.customerAndInvoice(ws);
      const refused = await c.post(`/v1/workspaces/${ws}/invoices/${second}/submit`);
      expect(refused.status).toBe(402);
      expect(refused.body.code).toBe('TRIAL_ENDED');
      expect((await c.get(`/v1/workspaces/${ws}/invoices/${second}`)).body.status).toBe('draft');
    });
  });

  describe('E10-2 checkout, receipts, upgrades and renewals', () => {
    it('activates a plan after a confirmed payment, once, and emails a receipt', async () => {
      const c = new Client(app);
      const { workspaceId: ws, email } = await c.onboard();
      const { reference, amount, confirmed } = await pay(c, ws, 'starter', 'monthly');
      expect(amount).toBe(priceKobo('starter', 'monthly'));
      expect(confirmed.status).toBe('success');
      expect(confirmed.summary).toMatchObject({ plan: 'starter', interval: 'monthly', status: 'active', card: { last4: '4081' }, usage: { limit: 50 } });

      // Confirming again (or a late webhook) changes nothing.
      const again = await c.post(`/v1/workspaces/${ws}/billing/confirm`, { reference });
      expect(again.body.summary.currentPeriodEnd).toBe(confirmed.summary.currentPeriodEnd);
      const payments = await c.get(`/v1/workspaces/${ws}/billing/payments`);
      expect(payments.body).toHaveLength(1);
      expect(payments.body[0]).toMatchObject({ status: 'success', amount, receiptNumber: expect.stringMatching(/^RCT-\d{6}-[0-9A-F]{8}$/) });

      const pdf = await c.agent.get(`/v1/workspaces/${ws}/billing/payments/${payments.body[0].id}/receipt.pdf`).set('X-Forwarded-For', c.ip);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(devInbox.some((m) => m.recipient === email && m.subject?.startsWith('Receipt RCT-'))).toBe(true);

      const job = await prisma.job.findFirst({ where: { workspaceId: ws, type: RENEW_JOB } });
      expect(job?.runAt.toISOString()).toBe(confirmed.summary.currentPeriodEnd);

      // A settled payment can't be edited, even directly in the database.
      await expect(
        prisma.scoped({ workspaceId: ws, userId: null }).payment.update({ where: { reference }, data: { amount: 1 } }),
      ).rejects.toThrow(/Settled payments cannot be changed/);
    });

    it('records a declined checkout without changing the plan', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const { confirmed } = await pay(c, ws, 'business', 'monthly', 'failed');
      expect(confirmed.status).toBe('failed');
      expect(confirmed.summary.plan).toBe('trial');
    });

    it('charges an upgrade minus credit for unused days, and schedules a downgrade for renewal', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      await pay(c, ws, 'starter', 'monthly');
      const up = await pay(c, ws, 'business', 'monthly');
      const full = priceKobo('business', 'monthly');
      expect(up.amount).toBeLessThan(full);
      expect(up.amount).toBeGreaterThan(full - priceKobo('starter', 'monthly') - 100);
      expect(up.confirmed.summary).toMatchObject({ plan: 'business', status: 'active', usage: { limit: 500 } });

      const down = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'starter', interval: 'monthly' });
      expect(down.body).toMatchObject({ scheduled: true, effectiveAt: up.confirmed.summary.currentPeriodEnd });
      const s = (await c.get(`/v1/workspaces/${ws}/billing`)).body;
      expect(s).toMatchObject({ plan: 'business', nextPlan: 'starter' });
      expect((await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'business', interval: 'monthly' })).body.code).toBe('ALREADY_ON_PLAN');
    });

    it('renews on the saved card, retries a declined renewal during 7 days of grace, then pauses sending', async () => {
      const c = new Client(app);
      const { workspaceId: ws, email } = await c.onboard();
      await pay(c, ws, 'business', 'monthly');
      await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'starter', interval: 'monthly' }); // scheduled downgrade

      // Period ends: renewal charges the saved card at the scheduled plan's price.
      const end1 = new Date(Date.now() - 60_000);
      await setWorkspace(ws, { currentPeriodEnd: end1 });
      await renewNow(ws, end1);
      let s = (await c.get(`/v1/workspaces/${ws}/billing`)).body;
      expect(s).toMatchObject({ plan: 'starter', status: 'active', nextPlan: null });
      expect(new Date(s.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 27 * DAY);
      const renewal = (await c.get(`/v1/workspaces/${ws}/billing/payments`)).body[0];
      expect(renewal).toMatchObject({ kind: 'renewal', status: 'success', amount: priceKobo('starter', 'monthly') });

      // Next period: the card declines. Sending keeps working during grace; owners are told.
      MockPaymentProvider.declineRenewals = true;
      const end2 = new Date(Date.now() - 60_000);
      await setWorkspace(ws, { currentPeriodEnd: end2 });
      await renewNow(ws, end2);
      s = (await c.get(`/v1/workspaces/${ws}/billing`)).body;
      expect(s).toMatchObject({ status: 'past_due', canSend: true });
      expect(devInbox.some((m) => m.recipient === email && m.subject === 'Your E-Invoice payment did not go through')).toBe(true);
      const retry = await prisma.job.findFirst({ where: { workspaceId: ws, type: RENEW_JOB, dedupeKey: `renew:${ws}:${end2.toISOString()}:1` } });
      expect(retry).not.toBeNull();
      const { invoiceId } = await c.customerAndInvoice(ws);
      expect((await c.post(`/v1/workspaces/${ws}/invoices/${invoiceId}/submit`)).body.status).toBe('cleared');

      // Grace runs out: sending pauses, everything stays readable.
      const end3 = new Date(Date.now() - 8 * DAY);
      await setWorkspace(ws, { currentPeriodEnd: end3 });
      await renewNow(ws, end3, 7);
      s = (await c.get(`/v1/workspaces/${ws}/billing`)).body;
      expect(s).toMatchObject({ status: 'lapsed', canSend: false, block: { code: 'PLAN_LAPSED' } });
      const { invoiceId: blocked } = await c.customerAndInvoice(ws);
      expect((await c.post(`/v1/workspaces/${ws}/invoices/${blocked}/submit`)).status).toBe(402);
      expect((await c.get(`/v1/workspaces/${ws}/invoices/${invoiceId}`)).body.status).toBe('cleared');
      expect(devInbox.some((m) => m.recipient === email && m.subject === 'Your E-Invoice plan is paused')).toBe(true);
    }, 480_000); // walks three billing periods: many round trips to the remote test database

    it('accepts gateway webhooks only with a valid signature and settles from the gateway, not the body', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const co = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'pro', interval: 'yearly' });
      await c.post(`/v1/billing/test-checkout/${co.body.reference}`, { outcome: 'success' });
      const body = JSON.stringify({ event: 'charge.success', data: { reference: co.body.reference, amount: 1 } });
      const hook = (sig: string) =>
        c.agent.post('/v1/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(body);

      expect((await hook('bad')).status).toBe(401);
      expect((await c.get(`/v1/workspaces/${ws}/billing`)).body.plan).toBe('trial');
      const good = await hook(createHmac('sha512', 'mock-paystack-webhook').update(body).digest('hex'));
      expect(good.status).toBe(200);
      const s = (await c.get(`/v1/workspaces/${ws}/billing`)).body;
      expect(s).toMatchObject({ plan: 'pro', interval: 'yearly', status: 'active', usage: { limit: null } });
      const paid = (await c.get(`/v1/workspaces/${ws}/billing/payments`)).body[0];
      expect(paid.amount).toBe(priceKobo('pro', 'yearly')); // the gateway's amount, not the webhook body's
    });

    it('lets only owners and admins pay', async () => {
      const owner = new Client(app);
      const { workspaceId: ws } = await owner.onboard();
      const viewerEmail = randomEmail('viewer');
      const inv = await owner.post(`/v1/workspaces/${ws}/invitations`, { email: viewerEmail, role: 'viewer' });
      const viewer = new Client(app);
      await viewer.signUp(viewerEmail);
      await viewer.post(`/v1/invitations/${inv.body.inviteUrl.split('/invite/')[1]}/accept`);
      expect((await viewer.get(`/v1/workspaces/${ws}/billing`)).status).toBe(200); // the meter is visible to all
      expect((await viewer.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'starter', interval: 'monthly' })).status).toBe(403);
      expect((await viewer.get(`/v1/workspaces/${ws}/billing/payments`)).status).toBe(403);
    });
  });

  describe('E9-3 approval above an amount', () => {
    it('sends large invoices for approval by a second person and lets small ones through', async () => {
      const owner = new Client(app);
      const { workspaceId: ws } = await owner.onboard();
      expect((await owner.patch(`/v1/workspaces/${ws}`, { approvalThreshold: 100000 })).body.approvalThreshold).toBe(100000);

      const approverEmail = randomEmail('approver');
      const inv = await owner.post(`/v1/workspaces/${ws}/invitations`, { email: approverEmail, role: 'approver' });
      const approver = new Client(app);
      await approver.signUp(approverEmail);
      await approver.post(`/v1/invitations/${inv.body.inviteUrl.split('/invite/')[1]}/accept`);

      const small = await owner.customerAndInvoice(ws, [{ description: 'Sample', quantity: 1, unitPrice: 50000, discount: 0, vatTreatment: 'standard' }]);
      expect((await owner.post(`/v1/workspaces/${ws}/invoices/${small.invoiceId}/submit`)).body.status).toBe('cleared');

      const big = await owner.customerAndInvoice(ws); // ₦478,375
      const sent = await owner.post(`/v1/workspaces/${ws}/invoices/${big.invoiceId}/submit`);
      expect(sent.body.status).toBe('pending_approval');
      expect(devInbox.some((m) => m.recipient === approverEmail && m.body.includes('approval limit'))).toBe(true);

      const self = await owner.post(`/v1/workspaces/${ws}/invoices/${big.invoiceId}/approve`);
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('SECOND_APPROVER_REQUIRED');
      expect((await owner.post(`/v1/workspaces/${ws}/invoices/${big.invoiceId}/submit`)).body.code).toBe('SECOND_APPROVER_REQUIRED');

      const approved = await approver.post(`/v1/workspaces/${ws}/invoices/${big.invoiceId}/approve`);
      expect(approved.body.status).toBe('cleared');
    });

    it('is a Business and Pro feature once the trial is over', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      await pay(c, ws, 'starter', 'monthly');
      const r = await c.patch(`/v1/workspaces/${ws}`, { approvalThreshold: 100000 });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('PLAN_FEATURE');
      expect((await c.patch(`/v1/workspaces/${ws}`, { approvalThreshold: null })).status).toBe(200);
    });
  });

  describe('E8-1 IRN check', () => {
    it('confirms a genuine IRN (typed or from the QR code) and rejects unknown or test ones', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const { invoiceId } = await c.customerAndInvoice(ws);
      const cleared = (await c.post(`/v1/workspaces/${ws}/invoices/${invoiceId}/submit`)).body;
      const visitor = new Client(app);

      const typed = await visitor.get(`/v1/public/irn?q=${encodeURIComponent(cleared.irn)}`);
      expect(typed.body).toMatchObject({ valid: true, irn: cleared.irn, total: 478375 });
      const scanned = await visitor.get(`/v1/public/irn?q=${encodeURIComponent(cleared.qrPayload)}`);
      expect(scanned.body).toMatchObject({ valid: true, irn: cleared.irn });

      expect((await visitor.get('/v1/public/irn?q=INV000001-FAKE0000-20260101')).body).toMatchObject({ valid: false, reason: 'not_found' });
      expect((await visitor.get('/v1/public/irn?q=hello')).body).toMatchObject({ valid: false, reason: 'not_an_irn' });
      const ws2 = await c.get(`/v1/workspaces/${ws}`);
      expect((await visitor.get(`/v1/public/irn?q=${encodeURIComponent(ws2.body.mbsTestIrn)}`)).body.valid).toBe(false); // sandbox
    });
  });
});
