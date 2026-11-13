/**
 * Payment idempotency and reconciliation: duplicate checkouts, renewals that time out or are retried,
 * the 5-minute sweeper and the daily reconciliation. Uses the mock gateway, which behaves like
 * Paystack where it matters (a reference is only ever charged once).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { BillingService, RENEW_JOB } from '../src/billing/billing.service';
import { MockPaymentProvider } from '../src/billing/payment-provider';
import { runWithContext } from '../src/common/request-context';
import { devInbox } from '../src/platform/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Client, createTestApp } from './helpers';

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const MIN = 60_000;

d('Payment integrity (e2e, real Postgres with RLS)', () => {
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
    MockPaymentProvider.timeoutAfterCharge = false;
  });

  const db = (ws: string) => prisma.scoped({ workspaceId: ws, userId: null });
  const asSystem = <T>(ws: string, fn: () => Promise<T>) => runWithContext({ requestId: 'test', workspaceId: ws, userId: null }, fn);
  const checkout = (c: Client, ws: string, plan: string, interval = 'monthly') => c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan, interval });
  const payAtGateway = (c: Client, reference: string) => c.post(`/v1/billing/test-checkout/${reference}`, { outcome: 'success' });
  const summary = async (c: Client, ws: string) => (await c.get(`/v1/workspaces/${ws}/billing`)).body;
  const backdate = (ws: string, reference: string, ms: number) =>
    db(ws).payment.update({ where: { reference }, data: { createdAt: new Date(Date.now() - ms) } });

  async function paidBusiness() {
    const c = new Client(app);
    const { workspaceId: ws, email } = await c.onboard();
    const co = await checkout(c, ws, 'business');
    await payAtGateway(c, co.body.reference);
    await c.post(`/v1/workspaces/${ws}/billing/confirm`, { reference: co.body.reference });
    return { c, ws, email };
  }

  describe('checkout', () => {
    it('reuses the open checkout when the same plan is chosen again (second tab, retry)', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const a = await checkout(c, ws, 'starter');
      const b = await checkout(c, ws, 'starter');
      expect(b.body.reference).toBe(a.body.reference);
      expect(b.body.authorizationUrl).toBe(a.body.authorizationUrl);
      expect(await db(ws).payment.count()).toBe(1);

      // Paid in the first tab; the second tab asks again and is told it's done.
      await payAtGateway(c, a.body.reference);
      const again = await checkout(c, ws, 'starter');
      expect(again.body).toMatchObject({ alreadyPaid: true, reference: a.body.reference });
      expect((await summary(c, ws)).plan).toBe('starter');
    });

    it('refunds a second checkout that is paid for a period already paid', async () => {
      const c = new Client(app);
      const { workspaceId: ws, email } = await c.onboard();
      const a = await checkout(c, ws, 'starter');
      const b = await checkout(c, ws, 'business'); // a different plan in another tab
      expect(b.body.reference).not.toBe(a.body.reference);
      await payAtGateway(c, a.body.reference);
      await payAtGateway(c, b.body.reference);

      expect((await c.post(`/v1/workspaces/${ws}/billing/confirm`, { reference: a.body.reference })).body.status).toBe('success');
      const second = await c.post(`/v1/workspaces/${ws}/billing/confirm`, { reference: b.body.reference });
      expect(second.body.status).toBe('refunded');
      expect(second.body.summary.plan).toBe('starter'); // the second payment changed nothing
      expect(MockPaymentProvider.refunds).toContain(b.body.reference);
      expect(devInbox.some((m) => m.recipient === email && m.subject === 'We refunded a duplicate payment')).toBe(true);
      const rows = (await c.get(`/v1/workspaces/${ws}/billing/payments`)).body;
      expect(rows.find((p: { reference: string }) => p.reference === b.body.reference)).toMatchObject({ status: 'refunded' });
    });

    it('settles concurrent confirmations of two paid checkouts exactly once', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const a = await checkout(c, ws, 'pro');
      const b = await checkout(c, ws, 'starter');
      await payAtGateway(c, a.body.reference);
      await payAtGateway(c, b.body.reference);
      await Promise.all([
        c.post(`/v1/workspaces/${ws}/billing/confirm`, { reference: a.body.reference }),
        c.post(`/v1/workspaces/${ws}/billing/confirm`, { reference: b.body.reference }),
      ]);
      const statuses = (await db(ws).payment.findMany()).map((p) => p.status).sort();
      expect(statuses).toEqual(['refunded', 'success']);
    });
  });

  describe('renewals', () => {
    it('never charges twice when the gateway times out after charging the card', async () => {
      const { c, ws, email } = await paidBusiness();
      const end = new Date(Date.now() - MIN);
      await db(ws).workspace.update({ where: { id: ws }, data: { currentPeriodEnd: end } });
      const before = MockPaymentProvider.charges.length;

      MockPaymentProvider.timeoutAfterCharge = true;
      await asSystem(ws, () => billing.renew(end.toISOString(), 0));
      expect(MockPaymentProvider.charges.length).toBe(before + 1); // the card was charged…
      const pending = await db(ws).payment.findFirst({ where: { kind: 'renewal' } });
      expect(pending?.status).toBe('pending'); // …but we don't know yet
      expect(devInbox.some((m) => m.recipient === email && m.subject === 'Your E-Invoice payment did not go through')).toBe(false);

      // The retry checks the earlier attempt with the gateway instead of charging again.
      MockPaymentProvider.timeoutAfterCharge = false;
      await asSystem(ws, () => billing.renew(end.toISOString(), 0));
      await asSystem(ws, () => billing.renew(end.toISOString(), 1));
      expect(MockPaymentProvider.charges.length).toBe(before + 1);
      const s = await summary(c, ws);
      expect(s.status).toBe('active');
      expect(new Date(s.currentPeriodEnd).getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    });

    it('charges once when the same renewal job runs twice at the same time', async () => {
      const { ws } = await paidBusiness();
      const end = new Date(Date.now() - MIN);
      await db(ws).workspace.update({ where: { id: ws }, data: { currentPeriodEnd: end } });
      const before = MockPaymentProvider.charges.length;
      await Promise.allSettled([asSystem(ws, () => billing.renew(end.toISOString(), 0)), asSystem(ws, () => billing.renew(end.toISOString(), 0))]);
      expect(MockPaymentProvider.charges.length).toBe(before + 1);
      expect(await db(ws).payment.count({ where: { kind: 'renewal', status: 'success' } })).toBe(1);
    });
  });

  describe('scheduled checks', () => {
    it('sweeper applies a payment whose confirmation never arrived', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const co = await checkout(c, ws, 'business');
      await payAtGateway(c, co.body.reference); // paid, but the payer closed the tab and the webhook was lost
      await backdate(ws, co.body.reference, 10 * MIN);
      const r = await billing.sweep();
      expect(r.settled).toBeGreaterThanOrEqual(1);
      expect((await summary(c, ws)).plan).toBe('business');
    });

    it('sweeper closes checkouts that were never paid after 48 hours', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const co = await checkout(c, ws, 'starter');
      await backdate(ws, co.body.reference, 49 * 3_600_000);
      await billing.sweep();
      expect((await db(ws).payment.findUnique({ where: { reference: co.body.reference } }))?.status).toBe('abandoned');
    });

    it('daily reconciliation fixes closed-but-paid checkouts and flags what it cannot fix', async () => {
      // 1) Paid at the gateway, but our record was closed as abandoned: reopened and applied.
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const co = await checkout(c, ws, 'pro');
      await payAtGateway(c, co.body.reference);
      await db(ws).payment.update({ where: { reference: co.body.reference }, data: { status: 'abandoned' } });

      // 2) A payment the gateway has that we never started.
      const ghost = `einv-ghost${Date.now()}`;
      MockPaymentProvider.external(ghost, 777_700);

      // 3) A payment we recorded that the gateway later reversed.
      const { ws: ws2 } = await paidBusiness();
      const reversed = (await db(ws2).payment.findFirst({ where: { status: 'success' } }))!.reference;
      MockPaymentProvider.reverse(reversed);

      // 4) A paid plan past its period end with no renewal job.
      const { ws: ws3 } = await paidBusiness();
      const lostEnd = new Date(Date.now() - 2 * 3_600_000);
      await db(ws3).workspace.update({ where: { id: ws3 }, data: { currentPeriodEnd: lostEnd } });

      const r = await billing.reconcile(new Date(Date.now() + 20 * MIN));
      expect(r.fixed).toBeGreaterThanOrEqual(1);
      expect((await summary(c, ws)).plan).toBe('pro');

      const open = await prisma.$queryRaw<{ reference: string; kind: string }[]>`
        SELECT reference, kind FROM app.open_payment_discrepancies(now() - interval '1 hour')`;
      expect(open).toEqual(expect.arrayContaining([{ reference: ghost, kind: 'unknown_reference' }, { reference: reversed, kind: 'missing_at_gateway' }]));

      const job = await prisma.job.findFirst({ where: { type: RENEW_JOB, dedupeKey: `renew:${ws3}:${lostEnd.toISOString()}:0` } });
      expect(job).not.toBeNull();

      // Running it again doesn't double-report.
      const again = await billing.reconcile(new Date(Date.now() + 20 * MIN));
      const openAfter = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM app.open_payment_discrepancies(now() - interval '1 hour') WHERE reference IN (${ghost}, ${reversed})`;
      expect(Number(openAfter[0]!.n)).toBe(2);
      expect(again.fixed).toBe(0);
    }, 480_000); // three businesses plus two full reconciliations against the remote test database
  });
});
