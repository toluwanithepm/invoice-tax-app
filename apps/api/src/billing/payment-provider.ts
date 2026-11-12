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

export interface PaymentResult {
  status: 'success' | 'failed' | 'abandoned' | 'pending';
  amountKobo: number;
  currency: string;
  channel: string | null;
  paidAt: Date | null;
  authorization: CardAuthorization | null;
  message: string | null;
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
  /** Charges a saved card for a renewal. */
  chargeAuthorization(input: {
    email: string;
    amountKobo: number;
    reference: string;
    authorizationCode: string;
  }): Promise<PaymentResult>;
  /** Checks the gateway's webhook signature over the raw request body. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
}

// ── Paystack ────────────────────────────────────────────────────────────

interface PaystackTx {
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

  private async call<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${env().PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || !json.status || !json.data)
      throw new Error(`Paystack ${path} failed: ${res.status} ${json.message ?? ''}`.trim());
    return json.data;
  }

  async initialize(input: {
    email: string;
    amountKobo: number;
    reference: string;
    callbackUrl: string;
    metadata: Record<string, string>;
  }) {
    const data = await this.call<{ authorization_url: string }>('/transaction/initialize', {
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
    return this.toResult(await this.call<PaystackTx>(`/transaction/verify/${encodeURIComponent(reference)}`));
  }

  async chargeAuthorization(input: {
    email: string;
    amountKobo: number;
    reference: string;
    authorizationCode: string;
  }) {
    try {
      const tx = await this.call<PaystackTx>('/transaction/charge_authorization', {
        method: 'POST',
        body: {
          email: input.email,
          amount: input.amountKobo,
          currency: 'NGN',
          reference: input.reference,
          authorization_code: input.authorizationCode,
        },
      });
      return this.toResult(tx);
    } catch (err) {
      return {
        status: 'failed' as const,
        amountKobo: 0,
        currency: 'NGN',
        channel: 'card',
        paidAt: null,
        authorization: null,
        message: (err as Error).message,
      };
    }
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature) return false;
    const expected = createHmac('sha512', env().PAYSTACK_SECRET_KEY!).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
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
            expiry:
              a.exp_month && a.exp_year ? `${a.exp_month.padStart(2, '0')}/${a.exp_year.slice(-2)}` : null,
          }
        : null,
      message: tx.gateway_response,
    };
  }
}

// ── Mock (development and tests) ────────────────────────────────────────

/** Test card authorization handed out by the mock checkout. */
export const MOCK_AUTH_CODE = 'AUTH_mock_reusable';

export class MockPaymentProvider implements PaymentProvider {
  readonly mode = 'mock' as const;
  /** Tests flip this to make saved-card renewals decline. */
  static declineRenewals = false;
  private static readonly sessions = new Map<
    string,
    { amountKobo: number; outcome: 'pending' | 'success' | 'failed'; channel: string }
  >();

  async initialize(input: { email: string; amountKobo: number; reference: string; callbackUrl: string }) {
    if (isProd()) throw new Error('The mock payment provider is disabled in production.');
    MockPaymentProvider.sessions.set(input.reference, {
      amountKobo: input.amountKobo,
      outcome: 'pending',
      channel: 'card',
    });
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
    return true;
  }

  async verify(reference: string): Promise<PaymentResult> {
    const s = MockPaymentProvider.sessions.get(reference);
    if (!s)
      return {
        status: 'abandoned',
        amountKobo: 0,
        currency: 'NGN',
        channel: null,
        paidAt: null,
        authorization: null,
        message: 'Unknown reference',
      };
    return {
      status: s.outcome,
      amountKobo: s.amountKobo,
      currency: 'NGN',
      channel: s.channel,
      paidAt: s.outcome === 'success' ? new Date() : null,
      authorization:
        s.outcome === 'success' && s.channel === 'card'
          ? { code: MOCK_AUTH_CODE, reusable: true, last4: '4081', brand: 'visa', expiry: '12/30' }
          : null,
      message: s.outcome === 'failed' ? 'Declined' : null,
    };
  }

  async chargeAuthorization(input: {
    amountKobo: number;
    reference: string;
    authorizationCode: string;
  }): Promise<PaymentResult> {
    const ok = !MockPaymentProvider.declineRenewals && input.authorizationCode === MOCK_AUTH_CODE;
    MockPaymentProvider.sessions.set(input.reference, {
      amountKobo: input.amountKobo,
      outcome: ok ? 'success' : 'failed',
      channel: 'card',
    });
    return this.verify(input.reference);
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature) return false;
    const expected = createHmac('sha512', 'mock-paystack-webhook').update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }
}

export const paymentProviderFactory = (): PaymentProvider =>
  env().PAYMENT_PROVIDER === 'paystack' ? new PaystackProvider() : new MockPaymentProvider();
