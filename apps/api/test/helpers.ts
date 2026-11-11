import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { randomInt } from 'crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { devInbox } from '../src/platform/notifications.service';

export const ORIGIN = 'http://localhost:3000';

export async function createTestApp() {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app);
  await app.init();
  return app;
}

export const randomTin = () => `${randomInt(10_000_000, 99_999_999)}-0001`;
export const randomEmail = (p = 'user') => `${p}.${Date.now()}.${randomInt(1e6)}@example.test`;
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * A signed-in browser: keeps cookies, sends Origin and the CSRF header like the web app does.
 */
export class Client {
  readonly agent: ReturnType<typeof request.agent>;
  csrf = '';
  /** Each client looks like a different device, so per-IP rate limits don't leak between tests. */
  readonly ip = `10.${randomInt(255)}.${randomInt(255)}.${randomInt(1, 255)}`;
  constructor(readonly app: NestExpressApplication) {
    this.agent = request.agent(app.getHttpServer());
  }

  private capture(res: request.Response) {
    const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const c = set.find((s) => s.startsWith('csrf='));
    if (c) this.csrf = decodeURIComponent(c.split(';')[0]!.slice(5));
    return res;
  }

  get(url: string) {
    return this.agent.get(url).set('X-Forwarded-For', this.ip).then((r) => this.capture(r));
  }
  send(method: 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
    const req = this.agent[method](url).set('X-Forwarded-For', this.ip).set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf);
    return (body === undefined ? req : req.send(body as object)).then((r) => this.capture(r));
  }
  post(url: string, body?: unknown) {
    return this.send('post', url, body ?? {});
  }
  put(url: string, body?: unknown) {
    return this.send('put', url, body);
  }
  patch(url: string, body?: unknown) {
    return this.send('patch', url, body);
  }
  del(url: string) {
    return this.send('delete', url);
  }

  /** Full OTP sign-up through the public API, reading the code from the dev inbox. */
  async signUp(email = randomEmail(), name = 'Test User') {
    const r1 = await this.post('/v1/auth/otp/request', { channel: 'email', identifier: email, name, consent: true });
    if (r1.status !== 200) throw new Error(`otp request failed: ${r1.status} ${JSON.stringify(r1.body)}`);
    const code = lastCodeFor(email);
    const r2 = await this.post('/v1/auth/otp/verify', { challengeId: r1.body.challengeId, code });
    if (r2.status !== 200) throw new Error(`otp verify failed: ${r2.status} ${JSON.stringify(r2.body)}`);
    return { email, userId: r2.body.userId as string };
  }

  /** Signs up, creates a workspace and takes it live on MBS (the E1 onboarding path). */
  async onboard(opts: { tin?: string } = {}) {
    const user = await this.signUp();
    const ws = await this.post('/v1/workspaces', { legalName: 'Test Traders Ltd', tin: opts.tin ?? randomTin(), turnover: 600_000_000 });
    if (ws.status !== 201) throw new Error(`workspace create failed: ${ws.status} ${JSON.stringify(ws.body)}`);
    const id = ws.body.id as string;
    await this.post(`/v1/workspaces/${id}/mbs/connect`);
    await this.post(`/v1/workspaces/${id}/mbs/test`);
    const live = await this.post(`/v1/workspaces/${id}/mbs/go-live`);
    if (live.body.mbsStatus !== 'live') throw new Error(`go-live failed: ${JSON.stringify(live.body)}`);
    return { ...user, workspaceId: id };
  }

  async customerAndInvoice(workspaceId: string, lines = [{ description: 'Rice 50kg', quantity: 10, unitPrice: 45000, discount: 5000, vatTreatment: 'standard' }]) {
    const c = await this.post(`/v1/workspaces/${workspaceId}/customers`, { name: 'Buyer Ltd', kind: 'B2B', tin: randomTin(), email: 'ap@buyer.test' });
    if (c.status !== 201) throw new Error(`customer failed: ${JSON.stringify(c.body)}`);
    const inv = await this.post(`/v1/workspaces/${workspaceId}/invoices`, { customerId: c.body.id, issueDate: today(), lines });
    if (inv.status !== 201) throw new Error(`invoice failed: ${JSON.stringify(inv.body)}`);
    return { customerId: c.body.id as string, invoiceId: inv.body.id as string, invoice: inv.body };
  }
}

export function lastCodeFor(recipient: string) {
  const m = [...devInbox].reverse().find((x) => x.recipient === recipient && /code is (\d{6})/.test(x.body));
  if (!m) throw new Error(`no OTP for ${recipient}`);
  return /code is (\d{6})/.exec(m.body)![1]!;
}
