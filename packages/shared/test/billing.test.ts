import { describe, expect, it } from 'vitest';
import { addMonths, isUpgrade, lagosMonthStart, planState, priceKobo, prorationCredit, sendBlock } from '../src/billing';

const DAY = 86_400_000;

describe('billing rules (E10)', () => {
  it('prices yearly plans at ten months', () => {
    expect(priceKobo('starter', 'monthly')).toBe(500_000);
    expect(priceKobo('business', 'yearly')).toBe(15_000_000);
  });

  it('adds calendar months, clamping to month end', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2026-11-12T00:00:00Z'), 12).toISOString()).toBe('2027-11-12T00:00:00.000Z');
  });

  it('starts the usage month at midnight in Lagos', () => {
    expect(lagosMonthStart(new Date('2026-12-01T00:30:00Z')).toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(lagosMonthStart(new Date('2026-11-30T22:59:00Z')).toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });

  it('derives status from dates: trial, active, 7 days of grace, then lapsed', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    expect(planState({ plan: 'trial', trialEndsAt: new Date(now.getTime() + DAY), currentPeriodEnd: null }, now).status).toBe('trialing');
    expect(planState({ plan: 'trial', trialEndsAt: new Date(now.getTime() - 1), currentPeriodEnd: null }, now).status).toBe('trial_ended');
    const paid = (endOffset: number) => planState({ plan: 'starter', trialEndsAt: null, currentPeriodEnd: new Date(now.getTime() + endOffset) }, now);
    expect(paid(DAY).status).toBe('active');
    expect(paid(-DAY).status).toBe('past_due');
    expect(paid(-6.9 * DAY).status).toBe('past_due');
    expect(paid(-7 * DAY).status).toBe('lapsed');
  });

  it('blocks sending only when the trial ended, the plan lapsed or the limit is used', () => {
    expect(sendBlock('active', 49, 50, false)).toBeNull();
    expect(sendBlock('active', 50, 50, false)?.code).toBe('PLAN_LIMIT_REACHED');
    expect(sendBlock('active', 10_000, null, false)).toBeNull();
    expect(sendBlock('past_due', 1, 50, false)).toBeNull();
    expect(sendBlock('lapsed', 0, 50, false)?.code).toBe('PLAN_LAPSED');
    expect(sendBlock('trialing', 20, 20, true)?.message).toContain('free trial');
    expect(sendBlock('trial_ended', 0, 20, true)?.code).toBe('TRIAL_ENDED');
  });

  it('credits unused days on upgrade and treats cheaper choices as downgrades', () => {
    const periodEnd = new Date('2026-12-12T00:00:00Z');
    const half = new Date('2026-11-27T00:00:00Z'); // 15 of 30 days left
    expect(prorationCredit({ plan: 'starter', interval: 'monthly', periodEnd }, half)).toBe(250_000);
    expect(prorationCredit({ plan: 'starter', interval: 'monthly', periodEnd }, new Date('2027-01-01'))).toBe(0);
    expect(isUpgrade({ plan: 'starter', interval: 'monthly' }, { plan: 'business', interval: 'monthly' })).toBe(true);
    expect(isUpgrade({ plan: 'business', interval: 'monthly' }, { plan: 'starter', interval: 'yearly' })).toBe(false);
    expect(isUpgrade({ plan: 'starter', interval: 'monthly' }, { plan: 'starter', interval: 'yearly' })).toBe(true);
    expect(isUpgrade({ plan: 'pro', interval: 'yearly' }, { plan: 'pro', interval: 'monthly' })).toBe(false);
  });
});
