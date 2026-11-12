/**
 * Security regression suite: each test plays an attacker against the real API and real Postgres
 * (with RLS). Covers rate limiting and brute force, injection, broken access control across
 * tenants and roles, CSRF, payment forgery, malformed input and security headers.
 * Run with the rest of the e2e suite: `pnpm --filter @einv/api test`.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac, randomInt } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { devInbox } from '../src/platform/notifications.service';
import { Client, createTestApp, ORIGIN, randomEmail, randomTin, today } from './helpers';

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const fakeIp = () => `172.${randomInt(16, 31)}.${randomInt(255)}.${randomInt(1, 255)}`;

const SQLI = [
  "' OR '1'='1",
  "'; DROP TABLE app.invoices; --",
  "1' UNION SELECT id, email FROM app.users --",
  "\\'; SELECT pg_sleep(5); --",
  '%27%20OR%201%3D1--',
  "' OR 1=1; UPDATE app.workspaces SET plan='pro' --",
];

d('Security (e2e attacks against the real API)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app?.close();
  });

  const otpRequest = (c: Client, email: string, ip = c.ip) =>
    c.agent.post('/v1/auth/otp/request').set('Origin', ORIGIN).set('X-Forwarded-For', ip).send({ channel: 'email', identifier: email, name: 'Attacker', consent: true });

  // ── 1. Rate limiting and brute force ──────────────────────────────────

  describe('rate limiting and brute force', () => {
    it('limits sign-in codes per email address even when the attacker rotates IP addresses', async () => {
      const c = new Client(app);
      const victim = randomEmail('victim');
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await otpRequest(c, victim, fakeIp())).status);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429]);
    });

    it('limits sign-in codes per IP address across many different emails (SMS/email pumping)', async () => {
      const c = new Client(app);
      let blockedAt = -1;
      for (let i = 0; i < 32; i++) {
        const r = await otpRequest(c, randomEmail(`pump${i}`));
        if (r.status === 429) {
          blockedAt = i;
          break;
        }
      }
      expect(blockedAt).toBe(30); // 30 allowed per 15 minutes, the 31st is refused
      const r = await otpRequest(c, randomEmail('pump-after'));
      expect(r.status).toBe(429);
      expect(r.body.code).toBe('RATE_LIMITED');
    });

    it('locks a sign-in code after 5 wrong guesses, so the right code no longer works', async () => {
      const c = new Client(app);
      const email = randomEmail('brute');
      const req = await otpRequest(c, email);
      const challengeId = req.body.challengeId as string;
      const real = /code is (\d{6})/.exec([...devInbox].reverse().find((m) => m.recipient === email)!.body)![1]!;
      const wrong = real === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const r = await c.agent.post('/v1/auth/otp/verify').set('Origin', ORIGIN).set('X-Forwarded-For', c.ip).send({ challengeId, code: wrong });
        expect(r.status).toBe(400);
      }
      const late = await c.agent.post('/v1/auth/otp/verify').set('Origin', ORIGIN).set('X-Forwarded-For', c.ip).send({ challengeId, code: real });
      expect(late.status).toBe(400);
      expect(late.headers['set-cookie']?.toString() ?? '').not.toContain('sid=');
    });

    it('rate-limits the public IRN check per IP address', async () => {
      const c = new Client(app);
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await c.get('/v1/public/irn?q=probe')).status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(30);
      expect(statuses.slice(30)).toEqual([429, 429]);
      // A different visitor is unaffected.
      expect((await new Client(app).get('/v1/public/irn?q=probe')).status).toBe(200);
    });

    it('rate-limits guessing public share links', async () => {
      // The limiter uses 10-minute fixed windows. Fire the guesses in parallel batches so they all land
      // in one window, and try again if a window boundary fell in the middle.
      const windowOf = () => Math.floor(Date.now() / 600_000);
      for (let attempt = 0; attempt < 2; attempt++) {
        const c = new Client(app);
        const w = windowOf();
        const statuses: number[] = [];
        for (let batch = 0; batch < 5; batch++) {
          const rs = await Promise.all(
            Array.from({ length: 25 }, (_, i) => c.get(`/v1/public/invoices/guess${batch}x${i}${randomInt(1e9)}`)),
          );
          statuses.push(...rs.map((r) => r.status));
        }
        if (windowOf() !== w) continue;
        expect(statuses.filter((s) => s === 404)).toHaveLength(120);
        expect(statuses.filter((s) => s === 429)).toHaveLength(5);
        return;
      }
      throw new Error('Could not complete the burst within one rate-limit window');
    }, 300_000);
  });

  // ── 2. Injection ──────────────────────────────────────────────────────

  describe('injection', () => {
    let c: Client;
    let ws: string;
    beforeAll(async () => {
      c = new Client(app);
      ws = (await c.onboard()).workspaceId;
      await c.customerAndInvoice(ws);
    });

    it.each(SQLI)('treats SQL in search boxes as text: %s', async (payload) => {
      const inv = await c.get(`/v1/workspaces/${ws}/invoices?q=${encodeURIComponent(payload)}`);
      expect(inv.status).toBe(200);
      expect(inv.body.items).toEqual([]);
      const cust = await c.get(`/v1/workspaces/${ws}/customers?q=${encodeURIComponent(payload)}`);
      expect(cust.status).toBe(200);
      expect(cust.body.items ?? cust.body).toEqual([]);
      const irn = await c.get(`/v1/public/irn?q=${encodeURIComponent(payload)}`);
      expect(irn.status).toBe(200);
      expect(irn.body.valid).toBe(false);
    });

    it('stores SQL and script payloads as plain text and keeps every table intact', async () => {
      const name = `Robert'); DROP TABLE app.invoices;-- <script>alert(document.cookie)</script>`;
      const r = await c.post(`/v1/workspaces/${ws}/customers`, { name, kind: 'B2B', tin: randomTin() });
      expect(r.status).toBe(201);
      expect(r.body.name).toBe(name);
      const back = await c.get(`/v1/workspaces/${ws}/customers/${r.body.id}`);
      expect(back.headers['content-type']).toContain('application/json');
      expect(back.body.name).toBe(name); // returned as JSON data, never as HTML
      expect((await c.get(`/v1/workspaces/${ws}/invoices`)).body.items.length).toBeGreaterThan(0); // table still there
    });

    it('rejects injection through path parameters before it reaches the database', async () => {
      for (const p of ["' OR 1=1 --", '..%2F..%2Fetc%2Fpasswd', '1;DROP TABLE app.users']) {
        const r = await c.get(`/v1/workspaces/${ws}/invoices/${encodeURIComponent(p)}`);
        expect([400, 404]).toContain(r.status);
        const w = await c.get(`/v1/workspaces/${encodeURIComponent(p)}`);
        expect([400, 403, 404]).toContain(w.status);
      }
    });

    it('rejects operator objects where plain values are expected (NoSQL-style injection)', async () => {
      const r = await c.post(`/v1/workspaces/${ws}/customers`, { name: 'Op Ltd', kind: 'B2B', tin: { contains: '' } });
      expect(r.status).toBe(400);
      const v = await new Client(app).agent
        .post('/v1/auth/otp/verify')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-For', c.ip)
        .send({ challengeId: { not: '' }, code: { gt: '' } });
      expect(v.status).toBe(400);
    });

    it('ignores prototype-pollution keys', async () => {
      const raw = `{"name":"Proto Ltd","kind":"B2B","tin":"${randomTin()}","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`;
      const r = await c.agent
        .post(`/v1/workspaces/${ws}/customers`)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', c.csrf)
        .set('X-Forwarded-For', c.ip)
        .set('Content-Type', 'application/json')
        .send(raw);
      expect(r.status).toBe(201);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(r.body.polluted).toBeUndefined();
    });

    it('refuses impossible money values', async () => {
      const { customerId } = await c.customerAndInvoice(ws);
      for (const line of [
        { description: 'Negative', quantity: -1, unitPrice: 1000, discount: 0, vatTreatment: 'standard' },
        { description: 'Huge', quantity: 1, unitPrice: 1e20, discount: 0, vatTreatment: 'standard' },
        { description: 'NaN', quantity: 'NaN', unitPrice: 1000, discount: 0, vatTreatment: 'standard' },
        { description: 'Bad VAT', quantity: 1, unitPrice: 1000, discount: 0, vatTreatment: 'tax_free_please' },
      ]) {
        const r = await c.post(`/v1/workspaces/${ws}/invoices`, { customerId, issueDate: today(), lines: [line] });
        expect(r.status).toBe(400);
      }
    });
  });

  // ── 3. Broken access control ──────────────────────────────────────────

  describe('access control', () => {
    let owner: Client;
    let ws: string;
    let invoiceId: string;
    let customerId: string;
    let paymentId: string;
    let reference: string;
    let attacker: Client;
    let attackerWs: string;

    beforeAll(async () => {
      owner = new Client(app);
      ws = (await owner.onboard()).workspaceId;
      ({ invoiceId, customerId } = await owner.customerAndInvoice(ws));
      const co = await owner.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'starter', interval: 'monthly' });
      reference = co.body.reference;
      await owner.post(`/v1/billing/test-checkout/${reference}`, { outcome: 'success' });
      await owner.post(`/v1/workspaces/${ws}/billing/confirm`, { reference });
      paymentId = (await owner.get(`/v1/workspaces/${ws}/billing/payments`)).body[0].id;

      attacker = new Client(app);
      attackerWs = (await attacker.onboard()).workspaceId;
    });

    it('requires a session, and rejects forged session cookies', async () => {
      const anon = await new Client(app).get(`/v1/workspaces/${ws}/invoices`);
      expect(anon.status).toBe(401);
      const r = await new Client(app).agent.get(`/v1/workspaces/${ws}/invoices`).set('Cookie', 'sid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(r.status).toBe(401);
    });

    it("can't read another business's records by guessing their IDs", async () => {
      const urls = [
        `/v1/workspaces/${ws}`,
        `/v1/workspaces/${ws}/invoices`,
        `/v1/workspaces/${ws}/invoices/${invoiceId}`,
        `/v1/workspaces/${ws}/invoices/${invoiceId}/pdf`,
        `/v1/workspaces/${ws}/customers/${customerId}`,
        `/v1/workspaces/${ws}/billing`,
        `/v1/workspaces/${ws}/billing/payments`,
        `/v1/workspaces/${ws}/billing/payments/${paymentId}/receipt.pdf`,
        `/v1/workspaces/${ws}/audit`,
        `/v1/workspaces/${ws}/reports/vat/${today().slice(0, 7)}`,
      ];
      for (const u of urls) {
        const r = await attacker.get(u);
        expect([403, 404]).toContain(r.status);
        expect(JSON.stringify(r.body ?? {})).not.toContain(invoiceId);
      }
    });

    it("can't reach another business's records through their own workspace either (RLS)", async () => {
      expect([403, 404]).toContain((await attacker.get(`/v1/workspaces/${attackerWs}/invoices/${invoiceId}`)).status);
      expect([403, 404]).toContain((await attacker.get(`/v1/workspaces/${attackerWs}/customers/${customerId}`)).status);
      expect([403, 404]).toContain((await attacker.get(`/v1/workspaces/${attackerWs}/billing/payments/${paymentId}/receipt.pdf`)).status);
      const confirm = await attacker.post(`/v1/workspaces/${attackerWs}/billing/confirm`, { reference });
      expect(confirm.status).toBe(404);
      const submit = await attacker.post(`/v1/workspaces/${attackerWs}/invoices/${invoiceId}/submit`);
      expect([403, 404]).toContain(submit.status);
    });

    it("can't change another business's records", async () => {
      expect([403, 404]).toContain((await attacker.patch(`/v1/workspaces/${ws}`, { legalName: 'Hijacked Ltd' })).status);
      expect([403, 404]).toContain((await attacker.del(`/v1/workspaces/${ws}/invoices/${invoiceId}`)).status);
      expect([403, 404]).toContain((await attacker.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'pro', interval: 'yearly' })).status);
      expect((await owner.get(`/v1/workspaces/${ws}`)).body.legalName).toBe('Test Traders Ltd');
    });

    it('stops role escalation and plan tampering', async () => {
      const viewerEmail = randomEmail('viewer');
      const inv = await owner.post(`/v1/workspaces/${ws}/invitations`, { email: viewerEmail, role: 'viewer' });
      const viewer = new Client(app);
      const { userId } = await viewer.signUp(viewerEmail);
      await viewer.post(`/v1/invitations/${inv.body.inviteUrl.split('/invite/')[1]}/accept`);

      expect((await viewer.patch(`/v1/workspaces/${ws}/members/${userId}`, { role: 'owner' })).status).toBe(403);
      expect((await viewer.post(`/v1/workspaces/${ws}/invitations`, { email: randomEmail('x'), role: 'owner' })).status).toBe(403);
      expect((await viewer.patch(`/v1/workspaces/${ws}`, { approvalRequired: false })).status).toBe(403);
      expect((await viewer.post(`/v1/workspaces/${ws}/invoices/${invoiceId}/submit`)).status).toBe(403);

      // Mass assignment: an owner can't grant themselves a paid plan through settings.
      const sneaky = await owner.patch(`/v1/workspaces/${ws}`, { legalName: 'Test Traders Ltd', plan: 'pro', currentPeriodEnd: '2099-01-01T00:00:00Z', trialEndsAt: '2099-01-01T00:00:00Z' });
      expect(sneaky.status).toBe(200);
      const b = (await owner.get(`/v1/workspaces/${ws}/billing`)).body;
      expect(b.plan).toBe('starter');
      expect(new Date(b.currentPeriodEnd).getFullYear()).toBeLessThan(2099);
      const sneaky2 = await owner.patch(`/v1/workspaces/${ws}/billing`, { autoRenew: true, plan: 'pro', currentPeriodEnd: '2099-01-01' });
      expect(sneaky2.body.plan).toBe('starter');
    });
  });

  // ── 4. CSRF ───────────────────────────────────────────────────────────

  describe('cross-site request forgery', () => {
    it('refuses state changes from other sites, without an Origin, or without the CSRF token', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const body = { name: 'CSRF Ltd', kind: 'B2B', tin: randomTin() };
      const url = `/v1/workspaces/${ws}/customers`;
      const evil = await c.agent.post(url).set('Origin', 'https://evil.example').set('X-CSRF-Token', c.csrf).send(body);
      expect(evil.status).toBe(403);
      expect(evil.body.code).toBe('BAD_ORIGIN');
      const noOrigin = await c.agent.post(url).set('X-CSRF-Token', c.csrf).send(body);
      expect(noOrigin.status).toBe(403);
      const noToken = await c.agent.post(url).set('Origin', ORIGIN).send(body);
      expect(noToken.status).toBe(403);
      expect(noToken.body.code).toBe('CSRF');
      const wrongToken = await c.agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', 'x'.repeat(24)).send(body);
      expect(wrongToken.status).toBe(403);
      const lookalike = await c.agent.post(url).set('Origin', `${ORIGIN}.evil.example`).set('X-CSRF-Token', c.csrf).send(body);
      expect(lookalike.status).toBe(403);
      expect((await c.get(`${url}?q=CSRF`)).body.items ?? []).toHaveLength(0);
    });
  });

  // ── 5. Payment forgery ────────────────────────────────────────────────

  describe('payment forgery', () => {
    const sign = (body: string, secret = 'mock-paystack-webhook') => createHmac('sha512', secret).update(body).digest('hex');
    const hook = (c: Client, body: string, sig?: string) => {
      const r = c.agent.post('/v1/webhooks/paystack').set('Content-Type', 'application/json').set('X-Forwarded-For', c.ip);
      return (sig ? r.set('x-paystack-signature', sig) : r).send(body);
    };

    it('rejects unsigned, wrongly signed and re-signed webhooks', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const co = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'pro', interval: 'yearly' });
      const body = JSON.stringify({ event: 'charge.success', data: { reference: co.body.reference, amount: co.body.amount } });
      expect((await hook(c, body)).status).toBe(401);
      expect((await hook(c, body, sign(body, 'guessed-secret'))).status).toBe(401);
      expect((await hook(c, body.replace('charge.success', 'charge.success2'), sign(body))).status).toBe(401); // body altered after signing
      // Correctly signed, but the gateway never received the money: nothing changes.
      expect((await hook(c, body, sign(body))).status).toBe(200);
      expect((await c.get(`/v1/workspaces/${ws}/billing`)).body.plan).toBe('trial');
    });

    it('applies a replayed webhook only once', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const co = await c.post(`/v1/workspaces/${ws}/billing/checkout`, { plan: 'starter', interval: 'monthly' });
      await c.post(`/v1/billing/test-checkout/${co.body.reference}`, { outcome: 'success' });
      const body = JSON.stringify({ event: 'charge.success', data: { reference: co.body.reference } });
      await Promise.all([hook(c, body, sign(body)), hook(c, body, sign(body)), hook(c, body, sign(body))]);
      const end1 = (await c.get(`/v1/workspaces/${ws}/billing`)).body.currentPeriodEnd;
      await hook(c, body, sign(body));
      expect((await c.get(`/v1/workspaces/${ws}/billing`)).body.currentPeriodEnd).toBe(end1);
      const paid = await prisma.scoped({ workspaceId: ws, userId: null }).payment.count({ where: { status: 'success' } });
      expect(paid).toBe(1);
    });

    it('ignores webhooks for references that are not ours or are malformed', async () => {
      const c = new Client(app);
      for (const reference of ['einv-doesnotexist000000', "x'; DROP TABLE app.payments;--", '../../etc']) {
        const body = JSON.stringify({ event: 'charge.success', data: { reference } });
        expect((await hook(c, body, sign(body))).status).toBe(200);
      }
    });
  });

  // ── 6. Malformed input and denial of service ──────────────────────────

  describe('malformed input', () => {
    it('handles broken JSON, oversized bodies and wrong content types without crashing', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const url = `/v1/workspaces/${ws}/customers`;
      const send = () => c.agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', c.csrf).set('X-Forwarded-For', c.ip);
      expect((await send().set('Content-Type', 'application/json').send('{"name": "Broken')).status).toBe(400);
      const big = JSON.stringify({ name: 'Big Ltd', kind: 'B2B', tin: randomTin(), address: 'A'.repeat(1_200_000) });
      expect((await send().set('Content-Type', 'application/json').send(big)).status).toBe(413);
      const xml = await send().set('Content-Type', 'application/xml').send('<customer><name>X</name></customer>');
      expect(xml.status).toBeGreaterThanOrEqual(400);
      expect(xml.status).toBeLessThan(500);
      const deep = '{"a":'.repeat(5000) + '1' + '}'.repeat(5000);
      expect((await send().set('Content-Type', 'application/json').send(deep)).status).toBeLessThan(500);
    });
  });

  // ── 7. Headers and cookies ────────────────────────────────────────────

  describe('headers and cookies', () => {
    it('sends hardened security headers and hides the server stack', async () => {
      const r = await new Client(app).get('/v1/health');
      expect(r.headers['strict-transport-security']).toContain('max-age=63072000');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('issues an HttpOnly, SameSite session cookie and never echoes secrets in errors', async () => {
      const c = new Client(app);
      const email = randomEmail('cookie');
      const r1 = await c.post('/v1/auth/otp/request', { channel: 'email', identifier: email, name: 'Cookie', consent: true });
      expect(JSON.stringify(r1.body)).not.toMatch(/\b\d{6}\b/); // the code goes to the inbox, not the response
      const code = /code is (\d{6})/.exec([...devInbox].reverse().find((m) => m.recipient === email)!.body)![1]!;
      const r2 = await c.post('/v1/auth/otp/verify', { challengeId: r1.body.challengeId, code });
      const sid = ([] as string[]).concat(r2.headers['set-cookie'] ?? []).find((s) => s.startsWith('sid='))!;
      expect(sid).toMatch(/HttpOnly/i);
      expect(sid).toMatch(/SameSite=Lax/i);
      expect(sid).toMatch(/Path=\//);

      const err = await c.get('/v1/workspaces/00000000-0000-0000-0000-000000000000/invoices/not-a-uuid');
      expect(JSON.stringify(err.body)).not.toMatch(/prisma|postgres|stack|at \w+ \(/i);
    });
  });
});
