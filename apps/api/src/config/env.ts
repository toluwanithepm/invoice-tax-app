import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');
const key32 = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 random bytes, base64-encoded');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.string().default('info'),
  SESSION_SECRET: key32,
  DATA_ENCRYPTION_KEY: key32,
  CRON_SECRET: z.string().min(16),
  JOBS_INPROCESS: bool.default(false),
  OTP_DEV_ECHO: bool.default(false),
  ACCESS_POINT_PROVIDER: z.enum(['mock']).default('mock'),
  TAX_ID_REGISTRY: z.enum(['mock']).default('mock'),
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  SMS_PROVIDER: z.enum(['console', 'termii']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('E-Invoice <no-reply@example.com>'),
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER_ID: z.string().optional(),
  WHATSAPP_PROVIDER: z.enum(['console']).default('console'),
  /** E10-2 payment gateway. `mock` gives a built-in test checkout and is refused in production. */
  PAYMENT_PROVIDER: z.enum(['mock', 'paystack']).default('mock'),
  /** Where payment reconciliation problems are emailed (optional). */
  OPS_ALERT_EMAIL: z.string().email().optional(),
  PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, 'must be a Paystack secret key (sk_test_… or sk_live_…)').optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Validates configuration once at boot; a bad deploy fails fast instead of at first request. */
export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.OTP_DEV_ECHO) throw new Error('OTP_DEV_ECHO must be off in production');
  if (e.NODE_ENV === 'production' && (e.EMAIL_PROVIDER === 'console' || e.SMS_PROVIDER === 'console')) {
    throw new Error('Console notification providers are not allowed in production');
  }
  if (e.PAYMENT_PROVIDER === 'paystack' && !e.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack');
  if (e.NODE_ENV === 'production' && e.PAYMENT_PROVIDER === 'mock') {
    // Fail closed: production without a gateway can show plans but cannot take (or fake) payments.
    console.warn('PAYMENT_PROVIDER=mock in production: checkout is disabled until Paystack is configured.');
  }
  cached = e;
  return e;
}

export const resetEnvCache = () => {
  cached = null;
};
export const isProd = () => env().NODE_ENV === 'production';
export const webOrigins = () =>
  env()
    .WEB_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
