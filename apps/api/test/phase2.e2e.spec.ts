import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { addDays, lagosToday } from '@einv/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { MockAccessPoint } from '../src/access-point/mock-access-point';
import { JobsService } from '../src/jobs/jobs.service';
import { B2cService } from '../src/b2c/b2c.service';
import { devInbox } from '../src/platform/notifications.service';
import { Client, createTestApp, ORIGIN, randomEmail, randomTin } from './helpers';

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d('Phase 2 (e2e, real Postgres with RLS)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const today = lagosToday();
  const month = today.slice(0, 7);

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

  const upload = (c: Client, url: string, csv: string, name = 'sales.csv') =>
    c.agent.post(url).set('X-Forwarded-For', c.ip).set('Origin', ORIGIN).set('X-CSRF-Token', c.csrf).attach('file', Buffer.from(csv), name);

  async function clearInvoice(c: Client, ws: string, customerId: string, lines: object[]) {
    const inv = await c.post(`/v1/workspaces/${ws}/invoices`, { customerId, issueDate: today, lines });
    const r = await c.post(`/v1/workspaces/${ws}/invoices/${inv.body.id}/submit`);
    expect(r.body.status).toBe('cleared');
    return r.body;
  }

  describe('E7 VAT reconciliation and reports', () => {
    it('totals cleared invoices and notes, lists exceptions, compares the filed figure, and exports matching files', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const { customerId } = await c.customerAndInvoice(ws, [{ description: 'Left as draft', quantity: 1, unitPrice: 10000, discount: 0, vatTreatment: 'standard' }]);
      const a = await clearInvoice(c, ws, customerId, [
        { description: 'Rice', quantity: 10, unitPrice: 45000, discount: 5000, vatTreatment: 'standard' },
        { description: 'Export freight', quantity: 1, unitPrice: 100000, discount: 0, vatTreatment: 'zero' },
      ]);
      const cn = await c.post(`/v1/workspaces/${ws}/invoices/${a.id}/credit-notes`, {
        reason: 'Returned 2 bags',
        issueDate: today,
        lines: [{ description: 'Rice returned', quantity: 2, unitPrice: 45000, vatTreatment: 'standard' }],
      });
      expect((await c.post(`/v1/workspaces/${ws}/invoices/${cn.body.id}/submit`)).body.status).toBe('cleared');

      const r = await c.get(`/v1/workspaces/${ws}/reports/vat/${month}`);
      expect(r.status).toBe(200);
      expect(r.body.invoices).toEqual({ count: 1, net: 545000, vat: 33375 });
      expect(r.body.creditNotes).toEqual({ count: 1, net: 90000, vat: 6750 });
      expect(r.body.outputVat).toBe(26625); // 33,375 − 6,750
      expect(r.body.byTreatment.find((t: { treatment: string }) => t.treatment === 'zero')).toMatchObject({ net: 100000, vat: 0 });
      expect(r.body.exceptions.unclearedDocuments).toHaveLength(1);
      expect(r.body.exceptions.unclearedVat).toBe(750);
      expect(r.body.difference).toBeNull();

      const declared = await c.put(`/v1/workspaces/${ws}/reports/vat/${month}/declaration`, { declaredVat: 27375, note: 'Filed on Rev360' });
      expect(declared.body.declared.vat).toBe(27375);
      expect(declared.body.difference).toBe(750);

      const xlsx = await c.agent.get(`/v1/workspaces/${ws}/reports/vat/${month}/export.xlsx`).set('X-Forwarded-For', c.ip).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (x: Buffer) => chunks.push(x));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
      const summary = wb.getWorksheet('Summary')!;
      let outputCell: unknown = null;
      summary.eachRow((row) => {
        if (row.getCell(1).value === 'Output VAT') outputCell = row.getCell(4).value;
      });
      expect(outputCell).toBe(r.body.outputVat);
      expect(wb.getWorksheet('Documents')!.rowCount).toBe(1 + r.body.documents.length);

      const pdf = await c.agent.get(`/v1/workspaces/${ws}/reports/vat/${month}/export.pdf`).set('X-Forwarded-For', c.ip);
      expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('tracks outstanding payments; paid date is the only change allowed after clearance', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const { customerId } = await c.customerAndInvoice(ws);
      const inv = await clearInvoice(c, ws, customerId, [{ description: 'Goods', quantity: 1, unitPrice: 200000, discount: 0, vatTreatment: 'standard' }]);
      let dash = await c.get(`/v1/workspaces/${ws}/reports/dashboard?months=3`);
      expect(dash.body.outstanding.total).toBe(215000);
      expect(dash.body.thisMonth.vatOwed).toBe(15000);
      expect(dash.body.months).toHaveLength(3);

      expect((await c.patch(`/v1/workspaces/${ws}/invoices/${inv.id}/payment`, { paid: true })).body.paid).toBe(true);
      dash = await c.get(`/v1/workspaces/${ws}/reports/dashboard?months=3&customerId=${customerId}`);
      expect(dash.body.outstanding.total).toBe(0);

      const db = prisma.scoped({ workspaceId: ws, userId: null });
      await expect(db.invoice.update({ where: { id: inv.id }, data: { total: 1 } })).rejects.toThrow(/IMMUTABLE/);
      await expect(db.invoice.update({ where: { id: inv.id }, data: { paidAt: null } })).resolves.toBeTruthy();
    });

    it('lets viewers read reports but not declare VAT', async () => {
      const owner = new Client(app);
      const { workspaceId: ws } = await owner.onboard();
      const email = randomEmail('viewer');
      const inv = await owner.post(`/v1/workspaces/${ws}/invitations`, { email, role: 'viewer' });
      const viewer = new Client(app);
      await viewer.signUp(email);
      await viewer.post(`/v1/invitations/${inv.body.inviteUrl.split('/invite/')[1]}/accept`);
      expect((await viewer.get(`/v1/workspaces/${ws}/reports/vat/${month}`)).status).toBe(200);
      expect((await viewer.put(`/v1/workspaces/${ws}/reports/vat/${month}/declaration`, { declaredVat: 1 })).status).toBe(403);
    });
  });

  describe('E5 B2C daily reporting', () => {
    const yesterday = addDays(today, -1);
    const twoDaysAgo = addDays(today, -2);
    const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

    it('uploads POS sales with row errors, reports a closed day, and locks it once accepted', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      await c.put(`/v1/workspaces/${ws}/b2c/settings`, { enabled: true });
      const csv = [
        'Sale Date,Receipt,Item,Amount,VAT',
        `${dmy(yesterday)},R-1,Bread,"₦1,075",standard`,
        `${dmy(yesterday)},R-2,Medicine,500,exempt`,
        `${dmy(yesterday)},R-1,Duplicate,200,standard`,
        `${addDays(today, 3)},R-9,Future sale,100,standard`,
        `${dmy(yesterday)},R-3,Bad amount,abc,standard`,
      ].join('\n');
      const up = await upload(c, `/v1/workspaces/${ws}/b2c/uploads`, csv);
      expect(up.status).toBe(201);
      expect(up.body.suggestedMapping).toMatchObject({ date: 'Sale Date', receiptNo: 'Receipt', amount: 'Amount', vatTreatment: 'VAT', description: 'Item' });

      const dry = await c.post(`/v1/workspaces/${ws}/b2c/uploads/${up.body.id}/commit?dryRun=true`, { mapping: up.body.suggestedMapping });
      expect(dry.body).toMatchObject({ total: 5, valid: 2, invalid: 3 });
      expect(dry.body.days).toEqual([{ date: yesterday, rows: 2, gross: 1575, vat: 75 }]);
      expect(dry.body.errors.map((e: { row: number }) => e.row).sort()).toEqual([4, 5, 6]);

      await c.post(`/v1/workspaces/${ws}/b2c/uploads/${up.body.id}/commit`, { mapping: up.body.suggestedMapping });
      const days = await c.get(`/v1/workspaces/${ws}/b2c/days?days=3`);
      expect(days.body.days.find((x: { date: string }) => x.date === yesterday)).toMatchObject({ status: 'pending', rows: 2, vat: 75 });

      expect((await c.post(`/v1/workspaces/${ws}/b2c/days/${today}/submit`)).body.code).toBe('DAY_NOT_CLOSED');
      const sent = await c.post(`/v1/workspaces/${ws}/b2c/days/${yesterday}/submit`);
      expect(sent.body.status).toBe('accepted');
      expect(sent.body.reportRef).toMatch(/^B2C-/);

      const again = await upload(c, `/v1/workspaces/${ws}/b2c/uploads`, `date,receipt_no,amount\n${yesterday},R-7,100\n`);
      const late = await c.post(`/v1/workspaces/${ws}/b2c/uploads/${again.body.id}/commit?dryRun=true`, { mapping: again.body.suggestedMapping });
      expect(late.body.errors[0].message).toMatch(/already been reported/);

      const db = prisma.scoped({ workspaceId: ws, userId: null });
      await expect(db.b2cReport.updateMany({ where: { workspaceId: ws }, data: { vatTotal: 0 } })).rejects.toThrow(/IMMUTABLE/);

      const nothing = await c.post(`/v1/workspaces/${ws}/b2c/days/${twoDaysAgo}/no-sales`);
      expect(nothing.body).toMatchObject({ status: 'accepted', noSales: true, rows: 0 });

      // Accepted B2C VAT flows into the month's reconciliation when the day falls in this month.
      if (yesterday.slice(0, 7) === month) {
        const r = await c.get(`/v1/workspaces/${ws}/reports/vat/${month}`);
        expect(r.body.b2c.vat).toBe(75);
        expect(r.body.outputVat).toBe(75);
      }
    });

    it('queues during an NRS outage and retries', async () => {
      const c = new Client(app);
      const { workspaceId: ws } = await c.onboard();
      const up = await upload(c, `/v1/workspaces/${ws}/b2c/uploads`, `date,receipt_no,amount\n${yesterday},A-1,1075\n`);
      await c.post(`/v1/workspaces/${ws}/b2c/uploads/${up.body.id}/commit`, { mapping: up.body.suggestedMapping });
      MockAccessPoint.outage = true;
      const r = await c.post(`/v1/workspaces/${ws}/b2c/days/${yesterday}/submit`);
      expect(r.body.status).toBe('pending');
      expect(r.body.errors[0].message).toMatch(/keep retrying/);
      MockAccessPoint.outage = false;
      await prisma.job.updateMany({ where: { workspaceId: ws, status: 'pending' }, data: { runAt: new Date(0) } });
      await app.get(JobsService).drain();
      const days = await c.get(`/v1/workspaces/${ws}/b2c/days?days=2`);
      expect(days.body.days.find((x: { date: string }) => x.date === yesterday).status).toBe('accepted');
    });

    it('alerts before the deadline when a day is missing and keeps the daily check going', async () => {
      const c = new Client(app);
      const { workspaceId: ws, email } = await c.onboard();
      await c.put(`/v1/workspaces/${ws}/b2c/settings`, { enabled: true });
      const before = devInbox.length;
      await app.get(B2cService).dailyCheck(ws, yesterday);
      const alert = devInbox.slice(before).find((m) => m.recipient === email);
      expect(alert?.subject).toMatch(/needs attention/);
      expect(alert?.body).toMatch(/has not been uploaded/);
      const next = await prisma.job.findUnique({ where: { dedupeKey: `b2c-check:${ws}:${today}` } });
      expect(next).not.toBeNull();
    });
  });

  describe('E6 accountant firm workspace', () => {
    it('gives firm members access to all firm clients, and nobody else', async () => {
      const acct = new Client(app);
      await acct.signUp();
      const firm = await acct.post('/v1/firms', { name: 'Bello & Co Chartered Accountants' });
      expect(firm.status).toBe(201);
      expect(firm.body).toMatchObject({ role: 'admin', billing: { clients: 0 } });
      expect(firm.body.connectCode).toMatch(/^[A-Z0-9]{8}$/);
      const firmId = firm.body.id;

      const ownerEmail = randomEmail('owner');
      const client = await acct.post(`/v1/firms/${firmId}/clients`, { legalName: 'Client One Ltd', tin: randomTin(), ownerEmail });
      expect(client.status).toBe(201);
      const ws = client.body.workspace.id;
      expect(client.body.invitation.inviteUrl).toContain('/invite/');

      // The accountant reaches the client through the firm, as "accountant".
      const me = await acct.get('/v1/me');
      expect(me.body.firms[0]).toMatchObject({ id: firmId, role: 'admin' });
      expect(me.body.workspaces.find((w: { id: string }) => w.id === ws)).toMatchObject({ role: 'accountant', viaFirmId: firmId });
      expect((await acct.get(`/v1/workspaces/${ws}`)).status).toBe(200);
      expect((await acct.post(`/v1/workspaces/${ws}/customers`, { name: 'Buyer Ltd', tin: randomTin() })).status).toBe(201);
      expect((await acct.post(`/v1/workspaces/${ws}/invitations`, { email: randomEmail(), role: 'clerk' })).status).toBe(403);

      const dash = await acct.get(`/v1/firms/${firmId}/dashboard`);
      expect(dash.body.totals.clients).toBe(1);
      expect(dash.body.clients[0]).toMatchObject({ workspaceId: ws, name: 'Client One Ltd', mbsStatus: 'not_connected', drafts: 0 });
      expect(dash.body.nextVatDue).toMatch(/-21$/);

      // Outsiders see nothing, at the API and in the database.
      const outsider = new Client(app);
      const { userId: outsiderId } = await outsider.signUp();
      expect((await outsider.get(`/v1/workspaces/${ws}`)).status).toBe(404);
      expect((await outsider.get(`/v1/firms/${firmId}`)).status).toBe(404);
      expect((await outsider.get(`/v1/firms/${firmId}/dashboard`)).status).toBe(404);
      const asOutsider = prisma.scoped({ workspaceId: null, userId: outsiderId });
      expect(await asOutsider.workspace.findUnique({ where: { id: ws } })).toBeNull();
      expect(await asOutsider.firm.findUnique({ where: { id: firmId } })).toBeNull();
      await expect(
        prisma.scopedTx((tx) => tx.$queryRaw`SELECT * FROM app.firm_dashboard(${firmId}::uuid, ${today}::date)`, { workspaceId: null, userId: outsiderId }),
      ).rejects.toThrow(/FORBIDDEN/);

      // A colleague joins by invitation and gets the same access.
      const colleagueEmail = randomEmail('colleague');
      const inv = await acct.post(`/v1/firms/${firmId}/invitations`, { email: colleagueEmail, role: 'accountant' });
      const colleague = new Client(app);
      await colleague.signUp(colleagueEmail);
      const token = inv.body.inviteUrl.split('/firm-invite/')[1];
      expect((await outsider.post(`/v1/firm-invitations/${token}/accept`)).body.code).toBe('INVITE_EMAIL_MISMATCH');
      expect((await colleague.post(`/v1/firm-invitations/${token}/accept`)).body).toMatchObject({ firmId, role: 'accountant' });
      expect((await colleague.get(`/v1/workspaces/${ws}`)).status).toBe(200);
      expect((await colleague.post(`/v1/firms/${firmId}/invitations`, { email: randomEmail(), role: 'accountant' })).status).toBe(403);
    });

    it('lets a business link to a firm by code, require approval, and unlink', async () => {
      const acct = new Client(app);
      await acct.signUp();
      const firm = (await acct.post('/v1/firms', { name: 'Firm Two' })).body;

      const owner = new Client(app);
      const { workspaceId: ws, email: ownerEmail } = await owner.onboard();
      expect((await acct.get(`/v1/workspaces/${ws}`)).status).toBe(404);
      expect((await owner.post(`/v1/workspaces/${ws}/firm/connect`, { code: 'ZZZZZZZZ' })).status).toBe(404);
      const linked = await owner.post(`/v1/workspaces/${ws}/firm/connect`, { code: firm.connectCode.toLowerCase() });
      expect(linked.body).toMatchObject({ firmId: firm.id, firmName: 'Firm Two' });
      expect((await owner.get(`/v1/workspaces/${ws}/firm`)).body.firmName).toBe('Firm Two');

      // E6-3: with approvals on, the accountant prepares and the owner approves from the emailed link.
      await owner.patch(`/v1/workspaces/${ws}`, { approvalRequired: true });
      const { invoiceId } = await acct.customerAndInvoice(ws);
      const before = devInbox.length;
      expect((await acct.post(`/v1/workspaces/${ws}/invoices/${invoiceId}/submit`)).body.status).toBe('pending_approval');
      const mail = devInbox.slice(before).find((m) => m.recipient === ownerEmail);
      expect(mail?.body).toContain(`/w/${ws}/invoices/${invoiceId}`);
      expect((await owner.post(`/v1/workspaces/${ws}/invoices/${invoiceId}/approve`)).body.status).toBe('cleared');

      expect((await acct.post(`/v1/workspaces/${ws}/firm/connect`, { code: firm.connectCode })).status).toBe(403);
      expect((await owner.del(`/v1/workspaces/${ws}/firm`)).status).toBe(204);
      expect((await acct.get(`/v1/workspaces/${ws}`)).status).toBe(404);
    });
  });
});
