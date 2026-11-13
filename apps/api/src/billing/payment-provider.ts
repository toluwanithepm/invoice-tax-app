import { createHmac } from 'node:crypto';
import { env, isProd } from '../config/env';
import { safeEqual } from '../common/crypto';

/**
 * E10-2 payment gateway seam. Paystack in real use; a built-in mock checkout for development and
 * tests. Callers never trust webhook bodies: every result comes from `verify` or `chargeAuthorization`.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface CardAuthorization {
  code: string;
  reusable: boolean;
  last4: string | null;
  brand: string | null;
  expiry: string | null; // MM/YY
}

/** `pending` also means "unknown": the gateway didn't give a final answer (e.g. a timeout). */
export interface PaymentResult {
  status: 'success' | 'failed' | 'abandoned' | 'pending';
  amountKobo: number;
  currency: string;
  channel: string | null;
  paidAt: Date | null;
  authorization: CardAuthorization | null;
  message: string | null;
}

export interface GatewayTransaction {
  reference: string;
  amountKobo: number;
  currency: string;
  paidAt: Date | null;
}

export interface PaymentProvider {
  readonly mode: 'mock' | 'paystack';
  /** Starts a hosted checkout (card, bank transfer or USSD) and returns where to send the payer. */
  initialize(input: {
    email: string;
    amountKobo: number;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, string>;
  }): Promise<{ authorizationUrl: string }>;
  verify(reference: string): Promise<PaymentResult>;
  /** Charges a saved card for a renewal. The same reference is never charged twice. */
  chargeAuthorization(input: {
    email: string;
    amountKobo: number;
    reference: string;
    authorizationCode: string;
  }): Promise<PaymentResult>;
  /** Checks the gateway's webhook signature over the raw request body. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
  /** Returns a payment in full (used for duplicate payments). */
  refund(reference: string): Promise<{ ok: boolean; message: string | null }>;
  /** Successful transactions in a time range, for the daily reconciliation. */
  listSuccessful(from: Date, to: Date): Promise<GatewayTransaction[]>;
}

/** `definitive` means the gateway answered and refused; otherwise the outcome is unknown (timeout, 5xx). */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
  ) {
    super(message);
  }
}

const unknownResult = (message: string): PaymentResult => ({
  status: 'pending',
  amountKobo: 0,
  currency: 'NGN',
  channel: 'card',
  paidAt: null,
  authorization: null,
  message,
});

// ── Paystack ────────────────────────────────────────────────────────────

interface PaystackTx {
  reference?: string;
  status: string;
  amount: number;
  currency: string;
  channel: string | null;
  paid_at: string | null;
  gateway_response: string | null;
  authorization?: {
    authorization_code: string;
    reusable: boolean;
    last4: string;
    brand: string;
    exp_month: string;
    exp_year: string;
  } | null;
}

export class PaystackProvider implements PaymentProvider {
  readonly mode = 'paystack' as const;
  private readonly base = 'https://api.paystack.co';

  private async call<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<{ data: T; pageCount: number }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: init?.method ?? 'GET',
        headers: { Authorization: `Bearer ${env().PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: init ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GatewayError(`Paystack ${path.split('?')[0]} unreachable: ${(err as Error).message}`, false);
    }
    const json = (await res.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: T;
      meta?: { pageCount?: number };
    };
    if (!res.ok || !json.status || json.data === undefined) {
      // A 4xx is Paystack's answer; a 5xx or unreadable body leaves the outcome unknown.
      throw new GatewayError(
        `Paystack ${path.split('?')[0]} failed: ${res.status} ${json.message ?? ''}`.trim(),
        res.status >= 400 && res.status < 500,
      );
    }
    return { data: json.data, pageCount: json.meta?.pageCount ?? 1 };
  }

  async initialize(input: {
    email: string;
    amountKobo: number;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, string>;
  }) {
    const { data } = await this.call<{ authorization_url: string }>('/transaction/initialize', {
      method: 'POST',
      body: {
        email: input.email,
        amount: input.amountKobo,
        currency: 'NGN',
        reference: input.reference,
        callback_url: input.callbackUrl,
        channels: ['card', 'bank_transfer', 'ussd'],
        metadata: input.metadata,
      },
    });
    return { authorizationUrl: data.authorization_url };
  }

  async verify(reference: string) {
    try {
      const { data } = await this.call<PaystackTx>(`/transaction/verify/${encodeURIComponent(reference)}`);
      return this.toResult(data);
    } catch (err) {
      const e = err as GatewayError;
      // Paystack answers 400 "Transaction reference not found" for a checkout nobody opened.
      if (e.definitive && /not found/i.test(e.message)) {
        return { status: 'abandoned' as const, amountKobo: 0, currency: 'NGN', channel: null, paidAt: null, authorization: null, message: e.message };
      }
      return unknownResult(e.message);
    }
  }

  async chargeAuthorization(input: { email: string; amountKobo: number; reference: string; authorizationCode: string }) {
    try {
      const { data } = await this.call<PaystackTx>('/transaction/charge_authorization', {
        method: 'POST',
        body: {
          email: input.email,
          amount: input.amountKobo,
          currency: 'NGN',
          reference: input.reference,
          authorization_code: input.authorizationCode,
        },
      });
      return this.toResult(data);
    } catch (err) {
      const e = err as GatewayError;
      // A repeated reference means this exact charge was attempted before: ask what happened to it.
      if (/duplicate/i.test(e.message)) return this.verify(input.reference);
      // Only a definite refusal is a failure; a timeout may still have charged the card.
      if (e instanceof GatewayError && e.definitive) {
        return { status: 'failed' as const, amountKobo: 0, currency: 'NGN', channel: 'card', paidAt: null, authorization: null, message: e.message };
      }
      return unknownResult(e.message);
    }
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature) return false;
    const expected = createHmac('sha512', env().PAYSTACK_SECRET_KEY!).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }

  async refund(reference: string) {
    try {
      await this.call('/refund', { method: 'POST', body: { transaction: reference } });
      return { ok: true, message: null };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async listSuccessful(from: Date, to: Date): Promise<GatewayTransaction[]> {
    const out: GatewayTransaction[] = [];
    for (let page = 1; page <= 50; page++) {
      const q = new URLSearchParams({ status: 'success', from: from.toISOString(), to: to.toISOString(), perPage: '100', page: String(page) });
      const { data, pageCount } = await this.call<PaystackTx[]>(`/transaction?${q.toString()}`);
      for (const t of data) {
        if (t.reference) out.push({ reference: t.reference, amountKobo: t.amount, currency: t.currency, paidAt: t.paid_at ? new Date(t.paid_at) : null });
      }
      if (page >= pageCount || data.length === 0) break;
    }
    return out;
  }

  private toResult(tx: PaystackTx): PaymentResult {
    const status =
      tx.status === 'success'
        ? 'success'
        : tx.status === 'abandoned'
          ? 'abandoned'
          : tx.status === 'failed' || tx.status === 'reversed'
            ? 'failed'
            : 'pending';
    const a = tx.authorization;
    return {
      status,
      amountKobo: tx.amount,
      currency: tx.currency,
      channel: tx.channel,
      paidAt: tx.paid_at ? new Date(tx.paid_at) : null,
      authorization: a?.authorization_code
        ? {
            code: a.authorization_code,
            reusable: !!a.reusable,
            last4: a.last4 ?? null,
            brand: a.brand ?? null,
            expiry: a.exp_month && a.exp_year ? `${a.exp_month.padStart(2, '0')}/${a.exp_year.slice(-2)}` : null,
          }
        : null,
      message: tx.gateway_response,
    };
  }
}

// ── Mock (development and tests) ────────────────────────────────────────

/** Test card authorization handed out by the mock checkout. */
export const MOCK_AUTH_CODE = 'AUTH_mock_reusable';

type MockSession = { amountKobo: number; outcome: 'pending' | 'success' | 'failed' | 'refunded'; channel: string; paidAt?: Date };

export class MockPaymentProvider implements PaymentProvider {
  readonly mode = 'mock' as const;
  /** Tests flip this to make saved-card renewals decline. */
  static declineRenewals = false;
  /** Tests flip this to simulate a timeout after the card was actually charged. */
  static timeoutAfterCharge = false;
  /** Every saved-card charge the gateway accepted (tests count double charges). */
  static readonly charges: string[] = [];
  static readonly refunds: string[] = [];
  private static readonly sessions = new Map<string, MockSession>();

  async initialize(input: { email: string; amountKobo: number; reference: string; callbackUrl: string }) {
    if (isProd()) throw new Error('The mock payment provider is disabled in production.');
    MockPaymentProvider.sessions.set(input.reference, { amountKobo: input.amountKobo, outcome: 'pending', channel: 'card' });
    const url = new URL('/billing/test-checkout', env().PUBLIC_APP_URL);
    url.searchParams.set('reference', input.reference);
    url.searchParams.set('amount', String(input.amountKobo));
    url.searchParams.set('return', input.callbackUrl);
    return { authorizationUrl: url.toString() };
  }

  /** Called by the test checkout page (and tests) to finish a payment. */
  static complete(reference: string, outcome: 'success' | 'failed', channel = 'card') {
    const s = MockPaymentProvider.sessions.get(reference);
    if (!s) return false;
    s.outcome = outcome;
    s.channel = channel;
    if (outcome === 'success') s.paidAt = new Date();
    return true;
  }

  /** The gateway reverses a payment (chargeback): it no longer counts as successful there. */
  static reverse(reference: string) {
    const s = MockPaymentProvider.sessions.get(reference);
    if (s) s.outcome = 'failed';
  }

  /** A payment the gateway has but this app never started (tests the reconciliation). */
  static external(reference: string, amountKobo: number) {
    MockPaymentProvider.sessions.set(reference, { amountKobo, outcome: 'success', channel: 'card', paidAt: new Date() });
  }

  async verify(reference: string): Promise<PaymentResult> {
    const s = MockPaymentProvider.sessions.get(reference);
    if (!s) {
      return { status: 'abandoned', amountKobo: 0, currency: 'NGN', channel: null, paidAt: null, authorization: null, message: 'Unknown reference' };
    }
    return {
      status: s.outcome === 'refunded' ? 'failed' : s.outcome,
      amountKobo: s.amountKobo,
      currency: 'NGN',
      channel: s.channel,
      paidAt: s.outcome === 'success' ? (s.paidAt ?? new Date()) : null,
      authorization:
        s.outcome === 'success' && s.channel === 'card'
          ? { code: MOCK_AUTH_CODE, reusable: true, last4: '4081', brand: 'visa', expiry: '12/30' }
          : null,
      message: s.outcome === 'failed' ? 'Declined' : null,
    };
  }

  async chargeAuthorization(input: { amountKobo: number; reference: string; authorizationCode: string }): Promise<PaymentResult> {
    // Like Paystack: a reference can only ever be charged once.
    if (MockPaymentProvider.sessions.has(input.reference)) return this.verify(input.reference);
    const ok = !MockPaymentProvider.declineRenewals && input.authorizationCode === MOCK_AUTH_CODE;
    MockPaymentProvider.sessions.set(input.reference, {
      amountKobo: input.amountKobo,
      outcome: ok ? 'success' : 'failed',
      channel: 'card',
      paidAt: ok ? new Date() : undefined,
    });
    if (ok) MockPaymentProvider.charges.push(input.reference);
    if (ok && MockPaymentProvider.timeoutAfterCharge) return unknownResult('Timed out');
    return this.verify(input.reference);
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature) return false;
    const expected = createHmac('sha512', 'mock-paystack-webhook').update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }

  async refund(reference: string) {
    const s = MockPaymentProvider.sessions.get(reference);
    if (!s || s.outcome !== 'success') return { ok: false, message: 'Nothing to refund' };
    s.outcome = 'refunded';
    MockPaymentProvider.refunds.push(reference);
    return { ok: true, message: null };
  }

  async listSuccessful(from: Date, to: Date): Promise<GatewayTransaction[]> {
    return [...MockPaymentProvider.sessions.entries()]
      .filter(([, s]) => (s.outcome === 'success' || s.outcome === 'refunded') && !!s.paidAt && s.paidAt >= from && s.paidAt < to)
      .map(([reference, s]) => ({ reference, amountKobo: s.amountKobo, currency: 'NGN', paidAt: s.paidAt ?? null }));
  }
}

export const paymentProviderFactory = (): PaymentProvider =>
  env().PAYMENT_PROVIDER === 'paystack' ? new PaystackProvider() : new MockPaymentProvider();
