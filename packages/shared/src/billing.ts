/**
 * E10 subscription rules, shared by the API (enforcement) and the web app (display).
 * Money is in kobo (₦1 = 100 kobo) so no floating point touches prices.
 */

export const PLAN_IDS = ['starter', 'business', 'pro'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
/** What is stored on the workspace: a paid plan, or the free trial. */
export type WorkspacePlan = PlanId | 'trial';

export const BILLING_INTERVALS = ['monthly', 'yearly'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const TRIAL_DAYS = 14;
/** E10-1: the trial includes up to this many NRS-approved invoices in total. */
export const TRIAL_INVOICE_LIMIT = 20;
/** E10-2: a failed renewal is retried for this many days before sending is paused. */
export const GRACE_DAYS = 7;
/** E10-3: prompt to upgrade from this share of the monthly limit. */
export const USAGE_WARN_AT = 0.8;
/** A yearly plan costs this many months (two months free). */
export const YEARLY_MONTHS = 10;
/** Smallest amount we will ask the payment gateway to charge after proration. */
export const MIN_CHARGE_KOBO = 10_000;

export interface PlanInfo {
  id: PlanId;
  name: string;
  tagline: string;
  monthlyKobo: number;
  /** Approved invoices per calendar month; null means unlimited. */
  invoiceLimit: number | null;
  /** E9-3: approval above an amount. */
  approvalRules: boolean;
  features: string[];
}

export const PLANS: Record<PlanId, PlanInfo> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    tagline: 'For small businesses getting compliant',
    monthlyKobo: 500_000,
    invoiceLimit: 50,
    approvalRules: false,
    features: [
      '50 approved invoices a month',
      'Credit and debit notes',
      'VAT reports and exports',
      'Share by WhatsApp, email or link',
    ],
  },
  business: {
    id: 'business',
    name: 'Business',
    tagline: 'For growing teams',
    monthlyKobo: 1_500_000,
    invoiceLimit: 500,
    approvalRules: true,
    features: [
      '500 approved invoices a month',
      'Everything in Starter',
      'Approval for large invoices',
      'Retail (B2C) daily reporting',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'For high volume and priority help',
    monthlyKobo: 4_000_000,
    invoiceLimit: null,
    approvalRules: true,
    features: ['Unlimited approved invoices', 'Everything in Business', 'Priority support'],
  },
};

export const isPlanId = (v: unknown): v is PlanId =>
  typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v);

export function priceKobo(plan: PlanId, interval: BillingInterval): number {
  return interval === 'yearly' ? PLANS[plan].monthlyKobo * YEARLY_MONTHS : PLANS[plan].monthlyKobo;
}

export const formatKobo = (kobo: number) =>
  `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: kobo % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Adds whole calendar months, clamping to the last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

export function periodEnd(start: Date, interval: BillingInterval): Date {
  return addMonths(start, interval === 'yearly' ? 12 : 1);
}

/** Start of the current calendar month in Lagos time (WAT, UTC+1, no daylight saving). */
export function lagosMonthStart(now: Date): Date {
  const lagos = new Date(now.getTime() + 3_600_000);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), 1) - 3_600_000);
}

export type PlanStatus = 'trialing' | 'trial_ended' | 'active' | 'past_due' | 'lapsed';

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  trialing: 'Free trial',
  trial_ended: 'Trial ended',
  active: 'Active',
  past_due: 'Payment due',
  lapsed: 'Paused',
};

export interface PlanStateInput {
  plan: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

/**
 * Status is derived from dates, so nothing has to run on time for a trial to end or a plan to
 * lapse. `past_due` keeps sending open while a renewal is retried (E10-2).
 */
export function planState(
  w: PlanStateInput,
  now = new Date(),
): { status: PlanStatus; graceEndsAt: Date | null } {
  if (!isPlanId(w.plan)) {
    const ends = w.trialEndsAt ?? now;
    return { status: now < ends ? 'trialing' : 'trial_ended', graceEndsAt: null };
  }
  const end = w.currentPeriodEnd;
  if (!end) return { status: 'lapsed', graceEndsAt: null };
  const grace = new Date(end.getTime() + GRACE_DAYS * 86_400_000);
  if (now < end) return { status: 'active', graceEndsAt: null };
  if (now < grace) return { status: 'past_due', graceEndsAt: grace };
  return { status: 'lapsed', graceEndsAt: grace };
}

export type SendBlock = {
  code: 'TRIAL_ENDED' | 'PLAN_LAPSED' | 'PLAN_LIMIT_REACHED';
  message: string;
} | null;

/** Why this workspace can't send another invoice to NRS right now, or null if it can. */
export function sendBlock(status: PlanStatus, used: number, limit: number | null, trial: boolean): SendBlock {
  if (status === 'trial_ended') {
    return {
      code: 'TRIAL_ENDED',
      message:
        'Your free trial has ended. Choose a plan to keep sending invoices to NRS. Your drafts and approved invoices are safe.',
    };
  }
  if (status === 'lapsed') {
    return {
      code: 'PLAN_LAPSED',
      message:
        'Your plan is paused because payment did not go through. Pay to keep sending invoices to NRS. Your drafts and approved invoices are safe.',
    };
  }
  if (limit !== null && used >= limit) {
    return trial
      ? {
          code: 'PLAN_LIMIT_REACHED',
          message: `You have used all ${limit} invoices in your free trial. Choose a plan to keep sending.`,
        }
      : {
          code: 'PLAN_LIMIT_REACHED',
          message: `You have sent ${limit} invoices to NRS this month, your plan's limit. Upgrade to keep sending, or wait until next month.`,
        };
  }
  return null;
}

/**
 * Credit for the unused part of the current paid period when upgrading, in kobo.
 * Uses list prices so the result does not depend on discounts or earlier proration.
 */
export function prorationCredit(
  current: { plan: PlanId; interval: BillingInterval; periodEnd: Date },
  now: Date,
): number {
  const start = addMonths(current.periodEnd, current.interval === 'yearly' ? -12 : -1);
  const total = current.periodEnd.getTime() - start.getTime();
  const left = Math.max(0, current.periodEnd.getTime() - now.getTime());
  return Math.floor((priceKobo(current.plan, current.interval) * left) / total);
}

/** An upgrade costs more per month than the current plan; anything else waits for renewal. */
export function isUpgrade(
  from: { plan: PlanId; interval: BillingInterval },
  to: { plan: PlanId; interval: BillingInterval },
): boolean {
  const perMonth = (p: { plan: PlanId; interval: BillingInterval }) =>
    priceKobo(p.plan, p.interval) / (p.interval === 'yearly' ? 12 : 1);
  if (from.plan === to.plan) return from.interval === 'monthly' && to.interval === 'yearly';
  return perMonth(to) > perMonth(from);
}
