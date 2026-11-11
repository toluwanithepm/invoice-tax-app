import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockAccessPoint } from '../src/access-point/mock-access-point';
import { JobsService } from '../src/jobs/jobs.service';
import { totpAt } from '../src/auth/totp';
import { Client, createTestApp, lastCodeFor, ORIGIN, randomEmail, randomTin, today } from './helpers';

const hasDb = !!process.env.TEST_DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d('API (e2e, real Postgres with RLS)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app?.close();
  });
  afterEach(() => {
    MockAccessPoint.outage = false;
    MockAccessPoint.forceErrors = null;
  });

  describe('health', () => {
    it('reports the database is up', async () => {
      const r = await request(app.getHttpServer()).get('/v1/health');
      expect(r.status).toBe(200);
      expect(r.body.db).toBe('ok');
    });
  });

  describe('authentication (E1-1, NFR-7)', () => {
    it('signs up with an emailed OTP and reads /v1/me', async () => {
      const c = new Client(app);
      const { email } = await c.signUp();
      const me = await c.get('/v1/me');
      expect(me.status).toBe(200);
      expect(me.body.email).toBe(email);
      expect(me.body.workspaces).toEqual([]);
    });

    it('requires consent for new accounts', async () => {
      const c = new Client(app);
      const email = randomEmail();
      const r1 = await c.post('/v1/auth/otp/request', { channel: 'email', identifier: email });
      const r2 = await c.post('/v1/auth/otp/verify', { challengeId: r1.body.challengeId, code: lastCodeFor(email) });
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe('CONSENT_REQUIRED');
    });

    it('locks a code after 5 wrong attempts and never reuses one', async () => {
      const c = new Client(app);
      const email = randomEmail();
      const r1 = await c.post('/v1/auth/otp/request', { channel: 'email', identifier: email, consent: true });
      const real = lastCodeFor(email);
      const wrong = real === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await c.post('/v1/auth/otp/verify', { challengeId: r1.body.challengeId, code: wrong });
      const r = await c.post('/v1/auth/otp/verify', { challengeId: r1.body.challengeId, code: real });
      expect(r.body.code).toBe('OTP_EXPIRED');
    });

    it('rejects requests without a session, from a foreign origin, or without the CSRF token', async () => {
      expect((await request(app.getHttpServer()).get('/v1/me')).status).toBe(401);
      const c = new Client(app);
      await c.signUp();
      const foreign = await c.agent.post('/v1/workspaces').set('Origin', 'https://evil.example').send({});
      expect(foreign.status).toBe(403);
      expect(foreign.body.code).toBe('BAD_ORIGIN');
      const noCsrf = await c.agent.post('/v1/workspaces').set('Origin', ORIGIN).send({ legalName: 'X Ltd', tin: randomTin() });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body.code).toBe('CSRF');
    });

    it('turns on TOTP 2FA and requires it at the next sign-in', async () => {
      const c = new Client(app);
      const { email } = await c.signUp();
      const setup = await c.post('/v1/auth/2fa/setup');
      expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect((await c.post('/v1/auth/2fa/enable', { code: '000000' })).body.code).toBe('TOTP_INVALID');
      const enabled = await c.post('/v1/auth/2fa/enable', { code: totpAt(setup.body.secret) });
      expect(enabled.body.recoveryCodes).toHaveLength(8);

      const again = new Client(app);
      const r1 = await again.post('/v1/auth/otp/request', { channel: 'email', identifier: email });
      const r2 = await again.post('/v1/auth/otp/verify', { challengeId: r1.body.challengeId, code: lastCodeFor(email) });
      expect(r2.body.mfaRequired).toBe(true);
      const blocked = await again.get('/v1/workspaces/00000000-0000-7000-8000-000000000000');
      expect(blocked.body.code).toBe('MFA_REQUIRED');
      expect((await again.post('/v1/auth/2fa/verify', { code: enabled.body.recoveryCodes[0] })).status).toBe(200);
      expect((await again.get('/v1/me')).body.mfaVerified).toBe(true);
    });

    it('logs out and the session stops working', async () => {
      const c = new Client(app);
      await c.signUp();
      expect((await c.post('/v1/auth/logout')).status).toBe(204);
      expect((await c.get('/v1/me')).status).toBe(401);
    });
  });

  describe('onboarding (E1-2, E1-3, E1-5)', () => {
    it('verifies the TIN, flags a registry name mismatch and goes live via the sandbox', async () => {
      const c = new Client(app);
      await c.signUp();
      const ws = await c.post('/v1/workspaces', { legalName: 'Amaka Distributors', tin: '12345678-0001', turnover: 800_000_000 });
      expect(ws.status).toBe(201);
      expect(ws.body.tinVerified).toBe(true);
      expect(ws.body.nameMismatch).toBe(true);
      expect(ws.body.registryName).toBe('Amaka Distribution Ltd');
      expect(ws.body.taxBand.goLive).toBe('2027-07-01');
      const id = ws.body.id;
      expect((await c.post(`/v1/workspaces/${id}/mbs/go-live`)).body.code).toBe('SANDBOX_NOT_PASSED');
      await c.post(`/v1/workspaces/${id}/mbs/connect`);
      const t = await c.post(`/v1/workspaces/${id}/mbs/test`);
      expect(t.body.passed).toBe(true);
      expect(t.body.irn).toMatch(/^SBX-/);
      expect((await c.post(`/v1/workspaces/${id}/mbs/go-live`)).body.mbsStatus).toBe('live');
    });

    it('rejects an unregistered TIN for MBS connection', async () => {
      const c = new Client(app);
      await c.signUp();
      const ws = await c.post('/v1/workspaces', { legalName: 'Ghost Ltd', tin: '00000000-0001' });
      expect(ws.body.tinVerified).toBe(false);
      expect((await c.post(`/v1/workspaces/${ws.body.id}/mbs/connect`)).body.code).toBe('TIN_NOT_VERIFIED');
    });

    it('stores bank account numbers encrypted', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const r = await c.patch(`/v1/workspaces/${workspaceId}`, { bankName: 'GTBank', bankAccountNumber: '0123456789', bankAccountName: 'Test Traders Ltd' });
      expect(r.status).toBe(200);
      expect(r.body.bankAccountLast4).toBe('6789');
      const raw = await prisma.scoped({ workspaceId, userId: null }).workspace.findUnique({ where: { id: workspaceId } });
      expect(raw!.bankAccountEnc).toMatch(/^v1\./);
      expect(raw!.bankAccountEnc).not.toContain('0123456789');
    });
  });

  describe('tenant isolation (NFR-14)', () => {
    it('hides other workspaces at the API and at the database (RLS)', async () => {
      const a = new Client(app);
      const b = new Client(app);
      const A = await a.onboard();
      const B = await b.onboard();
      const { invoiceId } = await a.customerAndInvoice(A.workspaceId);

      // API layer: B cannot open A's workspace, nor A's invoice through B's own workspace.
      expect((await b.get(`/v1/workspaces/${A.workspaceId}`)).status).toBe(404);
      expect((await b.get(`/v1/workspaces/${A.workspaceId}/invoices`)).status).toBe(404);
      expect((await b.get(`/v1/workspaces/${B.workspaceId}/invoices/${invoiceId}`)).status).toBe(404);

      // Database layer: the runtime role sees nothing outside the context workspace.
      const asB = prisma.scoped({ workspaceId: B.workspaceId, userId: B.userId });
      expect(await asB.invoice.findUnique({ where: { id: invoiceId } })).toBeNull();
      expect(await asB.workspace.findUnique({ where: { id: A.workspaceId } })).toBeNull();
      const noCtx = prisma.scoped({ workspaceId: null, userId: null });
      expect(await noCtx.invoice.count()).toBe(0);
      expect(await noCtx.customer.count()).toBe(0);
      await expect(
        asB.customer.create({ data: { workspaceId: A.workspaceId, name: 'Injected', tin: randomTin() } }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('customers, products and import (E2)', () => {
    it('flags duplicate customer Tax IDs unless confirmed', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const tin = randomTin();
      expect((await c.post(`/v1/workspaces/${workspaceId}/customers`, { name: 'One Ltd', tin })).status).toBe(201);
      const dup = await c.post(`/v1/workspaces/${workspaceId}/customers`, { name: 'One Ltd Branch', tin });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('DUPLICATE_CUSTOMER');
      expect((await c.post(`/v1/workspaces/${workspaceId}/customers?allowDuplicate=true`, { name: 'One Ltd Branch', tin })).status).toBe(201);
    });

    it('requires a VAT treatment on products', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const r = await c.post(`/v1/workspaces/${workspaceId}/products`, { name: 'Rice', unitPrice: 45000 });
      expect(r.status).toBe(400);
      expect(r.body.errors[0].field).toBe('vatTreatment');
    });

    it('imports a CSV with row-level errors (dry run, then commit)', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const csv = ['Product Name,Price,VAT', 'Rice 50kg,"45,000",7.5%', 'Beans,abc,standard', 'Palm oil,12000,exempt'].join('\n');
      const up = await c.agent
        .post(`/v1/workspaces/${workspaceId}/imports/products`)
        .set('X-Forwarded-For', c.ip)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', c.csrf)
        .attach('file', Buffer.from(csv), 'products.csv');
      expect(up.status).toBe(201);
      expect(up.body.suggestedMapping).toEqual({ name: 'Product Name', unitPrice: 'Price', vatTreatment: 'VAT' });
      const dry = await c.post(`/v1/workspaces/${workspaceId}/imports/${up.body.id}/commit?dryRun=true`, { mapping: up.body.suggestedMapping });
      expect(dry.body).toMatchObject({ total: 3, valid: 2, invalid: 1 });
      expect(dry.body.errors[0].row).toBe(3);
      const done = await c.post(`/v1/workspaces/${workspaceId}/imports/${up.body.id}/commit`, { mapping: up.body.suggestedMapping });
      expect(done.body.valid).toBe(2);
      const list = await c.get(`/v1/workspaces/${workspaceId}/products`);
      expect(list.body.items.map((p: { name: string }) => p.name).sort()).toEqual(['Palm oil', 'Rice 50kg']);
    });
  });

  describe('invoice clearance (E3)', () => {
    it('validates, clears, stamps IRN + QR, and locks the invoice', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const { invoiceId, invoice } = await c.customerAndInvoice(workspaceId);
      expect(invoice).toMatchObject({ subtotal: 450000, discountTotal: 5000, vatTotal: 33375, total: 478375, status: 'draft' });

      const v = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/validate`);
      expect(v.body).toEqual({ ok: true, errors: [] });

      const s = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);
      expect(s.status).toBe(200);
      expect(s.body.status).toBe('cleared');
      expect(s.body.number).toBe('INV-000001');
      expect(s.body.irn).toMatch(/^INV000001-[0-9A-F]{8}-\d{8}$/);
      expect(s.body.qrPayload).toBeTruthy();

      // Re-clicking submit is harmless.
      const again = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);
      expect(again.body.irn).toBe(s.body.irn);

      // Locked at the API and in the database (NFR-11).
      const edit = await c.put(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}`, { issueDate: today(), lines: [] });
      expect(edit.status).toBe(409);
      await expect(
        prisma.scoped({ workspaceId, userId: null }).invoice.update({ where: { id: invoiceId }, data: { total: 1 } }),
      ).rejects.toThrow(/IMMUTABLE/);

      const pdf = await c.agent.get(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/pdf`).set('X-Forwarded-For', c.ip);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('blocks submission with plain-language errors beside the field', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const inv = await c.post(`/v1/workspaces/${workspaceId}/invoices`, {
        issueDate: today(),
        lines: [{ description: '', quantity: 0, unitPrice: 100, vatTreatment: 'standard' }],
      });
      const r = await c.post(`/v1/workspaces/${workspaceId}/invoices/${inv.body.id}/submit`);
      expect(r.status).toBe(422);
      const fields = r.body.errors.map((e: { field: string }) => e.field);
      expect(fields).toEqual(expect.arrayContaining(['customerId', 'lines.0.description', 'lines.0.quantity']));
      expect(JSON.stringify(r.body)).not.toMatch(/NRS-E\d+"?,\s*"message":\s*"NRS/);
    });

    it('maps MBS rejections to plain language and keeps history on resubmission (E3-5)', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const { invoiceId } = await c.customerAndInvoice(workspaceId);
      MockAccessPoint.forceErrors = ['NRS-E103'];
      const r = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);
      expect(r.body.status).toBe('rejected');
      expect(r.body.errors[0]).toMatchObject({ code: 'NRS-E103', field: 'customer.tin' });
      expect(r.body.errors[0].message).toMatch(/Tax ID/);
      MockAccessPoint.forceErrors = null;
      const r2 = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);
      expect(r2.body.status).toBe('cleared');
      expect(r2.body.number).toBe(r.body.number);
      expect(r2.body.history.map((h: { outcome: string }) => h.outcome)).toEqual(['rejected', 'cleared']);
    });

    it('queues during an outage and retries without duplicate IRNs (E3-7, NFR-4)', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const { invoiceId } = await c.customerAndInvoice(workspaceId);
      MockAccessPoint.outage = true;
      const r = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);
      expect(r.body.status).toBe('queued');
      expect(r.body.nextAttemptAt).toBeTruthy();

      MockAccessPoint.outage = false;
      await prisma.job.updateMany({ where: { workspaceId, status: 'pending' }, data: { runAt: new Date(0) } });
      await app.get(JobsService).drain();
      const after = await c.get(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}`);
      expect(after.body.status).toBe('cleared');
      expect(after.body.history.map((h: { outcome: string }) => h.outcome)).toEqual(['unavailable', 'cleared']);
      expect(await prisma.mockMbsDocument.count({ where: { irn: after.body.irn } })).toBe(1);
    });
  });

  describe('credit and debit notes (E4)', () => {
    it('raises notes against the IRN and refuses over-crediting', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const { invoiceId } = await c.customerAndInvoice(workspaceId, [{ description: 'Goods', quantity: 1, unitPrice: 100000, discount: 0, vatTreatment: 'standard' }]);
      await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);

      const tooBig = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/credit-notes`, {
        reason: 'Returned goods',
        issueDate: today(),
        lines: [{ description: 'Goods', quantity: 2, unitPrice: 100000, vatTreatment: 'standard' }],
      });
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.code).toBe('CREDIT_EXCEEDS_REMAINING');

      const cn = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/credit-notes`, {
        reason: 'Returned 40%',
        issueDate: today(),
        lines: [{ description: 'Goods returned', quantity: 0.4, unitPrice: 100000, vatTreatment: 'standard' }],
      });
      expect(cn.status).toBe(201);
      const cleared = await c.post(`/v1/workspaces/${workspaceId}/invoices/${cn.body.id}/submit`);
      expect(cleared.body).toMatchObject({ status: 'cleared', docType: 'credit_note', number: 'CN-000001' });
      expect(cleared.body.originalInvoice.irn).toBeTruthy();

      const dn = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/debit-notes`, {
        reason: 'Under-billed freight',
        issueDate: today(),
        lines: [{ description: 'Freight', quantity: 1, unitPrice: 5000, vatTreatment: 'standard' }],
      });
      expect((await c.post(`/v1/workspaces/${workspaceId}/invoices/${dn.body.id}/submit`)).body.number).toBe('DN-000001');
    });
  });

  describe('roles and approvals (E9-1, E6-3 groundwork)', () => {
    it('lets a clerk prepare but not submit; with approvals on, an approver releases it', async () => {
      const owner = new Client(app);
      const { workspaceId } = await owner.onboard();
      const clerkEmail = randomEmail('clerk');
      const inv = await owner.post(`/v1/workspaces/${workspaceId}/invitations`, { email: clerkEmail, role: 'clerk' });
      expect(inv.status).toBe(201);
      const token = inv.body.inviteUrl.split('/invite/')[1];

      const clerk = new Client(app);
      await clerk.signUp(clerkEmail);
      expect((await clerk.post(`/v1/invitations/${token}/accept`)).body.role).toBe('clerk');
      const { invoiceId } = await clerk.customerAndInvoice(workspaceId);

      const refused = await clerk.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('SUBMIT_NOT_ALLOWED');
      expect((await clerk.patch(`/v1/workspaces/${workspaceId}`, { approvalRequired: true })).status).toBe(403);

      await owner.patch(`/v1/workspaces/${workspaceId}`, { approvalRequired: true });
      const pending = await clerk.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);
      expect(pending.body.status).toBe('pending_approval');
      expect((await clerk.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/approve`)).status).toBe(403);

      const approved = await owner.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/approve`);
      expect(approved.body.status).toBe('cleared');

      const audit = await owner.get(`/v1/workspaces/${workspaceId}/audit?entity=invoice&entityId=${invoiceId}`);
      const actions = audit.body.items.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['invoice.created', 'invoice.approval_requested', 'invoice.approved_and_submitted', 'invoice.cleared']));
    });

    it('refuses an invitation accepted by a different email', async () => {
      const owner = new Client(app);
      const { workspaceId } = await owner.onboard();
      const inv = await owner.post(`/v1/workspaces/${workspaceId}/invitations`, { email: randomEmail('x'), role: 'viewer' });
      const other = new Client(app);
      await other.signUp();
      const r = await other.post(`/v1/invitations/${inv.body.inviteUrl.split('/invite/')[1]}/accept`);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('INVITE_EMAIL_MISMATCH');
    });

    it('keeps the last owner', async () => {
      const owner = new Client(app);
      const { workspaceId, userId } = await owner.onboard();
      const r = await owner.patch(`/v1/workspaces/${workspaceId}/members/${userId}`, { role: 'admin' });
      expect(r.body.code).toBe('LAST_OWNER');
    });
  });

  describe('sharing (E3-6)', () => {
    it('serves a cleared invoice publicly by token, logs views, and stops after revocation', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const { invoiceId } = await c.customerAndInvoice(workspaceId);
      expect((await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/share`, { channel: 'link' })).body.code).toBe('NOT_CLEARED');
      await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/submit`);
      const share = await c.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/share`, { channel: 'whatsapp', recipient: '08031234567' });
      expect(share.body.whatsappUrl).toMatch(/^https:\/\/wa\.me\/2348031234567\?text=/);
      const token = share.body.url.split('/i/')[1];

      const pub = await request(app.getHttpServer()).get(`/v1/public/invoices/${token}`);
      expect(pub.status).toBe(200);
      expect(pub.body.irn).toBeTruthy();
      expect(pub.body).not.toHaveProperty('id');
      expect(pub.headers['x-robots-tag']).toContain('noindex');
      const pdf = await request(app.getHttpServer()).get(`/v1/public/invoices/${token}/pdf`);
      expect(pdf.headers['content-type']).toBe('application/pdf');

      const shares = await c.get(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/shares`);
      expect(shares.body[0].events.map((e: { event: string }) => e.event)).toEqual(['sent', 'viewed', 'downloaded']);

      await c.del(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/shares/${share.body.id}`);
      expect((await request(app.getHttpServer()).get(`/v1/public/invoices/${token}`)).status).toBe(404);
    });
  });

  describe('audit log (E9-2)', () => {
    it('is append-only for the runtime role', async () => {
      const c = new Client(app);
      const { workspaceId } = await c.onboard();
      const db = prisma.scoped({ workspaceId, userId: null });
      const ev = await db.auditEvent.findFirstOrThrow({ where: { workspaceId } });
      await expect(db.auditEvent.update({ where: { id: ev.id }, data: { action: 'tampered' } })).rejects.toThrow();
      await expect(db.auditEvent.delete({ where: { id: ev.id } })).rejects.toThrow();
    });
  });
});
