import { getStripe, isStripeConfigured } from './stripeClient';
import { getUserBillingDoc, setSubscription } from './subscriptionService';
import { getJobsMonthlyPriceId, getWeeklyPriceId } from './config';
import { resolvePriceMapping } from './priceRegistry';
import { resolveStripePromotionCode } from './stripePromoAudit';
import * as admin from 'firebase-admin';

interface StripeSubscriptionLike {
    id: string;
    status: string;
    cancel_at_period_end?: boolean;
    cancel_at?: number | null;
    customer: string | { id?: string };
    items: {
        data: Array<{
            id?: string;
            price?: { id?: string };
            current_period_end?: number;
            current_period_start?: number;
        }>;
    };
    billing_cycle_anchor?: number;
    current_period_end?: number;
    current_period_start?: number;
}

function periodEndSeconds(sub: StripeSubscriptionLike): number {
    return (
        sub.items?.data?.[0]?.current_period_end ??
        sub.current_period_end ??
        sub.billing_cycle_anchor ??
        Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
    );
}

function periodStartSeconds(sub: StripeSubscriptionLike): number {
    return (
        sub.items?.data?.[0]?.current_period_start ??
        sub.current_period_start ??
        sub.billing_cycle_anchor ??
        Math.floor(Date.now() / 1000)
    );
}

/** True when Stripe has scheduled cancellation (portal "Cancels on …"). */
function isCancelScheduled(sub: StripeSubscriptionLike): boolean {
    if (sub.cancel_at_period_end === true) return true;
    const cancelAt = sub.cancel_at;
    return typeof cancelAt === 'number' && cancelAt > Math.floor(Date.now() / 1000);
}

export async function writeSubscriptionFromStripe(sub: StripeSubscriptionLike, uid: string): Promise<void> {
    const priceId = sub.items?.data?.[0]?.price?.id ?? null;
    const mapping = priceId ? await resolvePriceMapping(priceId) : null;
    const mappedPlan = mapping?.plan ?? null;
    const interval = mapping?.interval ?? 'unknown';
    const isActive = sub.status === 'active' || sub.status === 'trialing';
    const isPastDue = sub.status === 'past_due';
    const retainsPlan = isActive || isPastDue;

    const weeklyId = getWeeklyPriceId();
    const jobsMonthlyId = getJobsMonthlyPriceId();
    if (weeklyId && priceId === weeklyId && mappedPlan !== 'jobs_premium') {
        throw new Error('WEEKLY_PLAN_MAPPING_VIOLATION');
    }
    if (jobsMonthlyId && priceId === jobsMonthlyId && mappedPlan !== 'jobs_premium') {
        throw new Error('JOBS_MONTHLY_PLAN_MAPPING_VIOLATION');
    }

    let stripePromotionCode: string | null = null;
    if (isActive && sub.id) {
        try {
            stripePromotionCode = await resolveStripePromotionCode(sub.id);
        } catch {
            stripePromotionCode = null;
        }
    }

    const { subscription: existing } = await getUserBillingDoc(uid);
    const plan: 'free' | 'part_time' | 'jobs_premium' | 'premium' = retainsPlan
        ? (mappedPlan ?? 'free')
        : 'free';
    const lastPaidPlan = retainsPlan
        ? plan === 'premium' || plan === 'jobs_premium' || plan === 'part_time'
            ? plan
            : existing.lastPaidPlan
        : existing.plan === 'premium' ||
            existing.plan === 'jobs_premium' ||
            existing.plan === 'part_time'
          ? existing.plan
          : existing.lastPaidPlan;

    await setSubscription(uid, {
        provider: 'stripe',
        plan,
        status: isActive ? 'active' : isPastDue ? 'past_due' : 'canceled',
        stripeSubscriptionId: retainsPlan ? sub.id : null,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
        priceId: retainsPlan ? priceId : null,
        billingInterval: retainsPlan ? interval : null,
        currentPeriodStart: admin.firestore.Timestamp.fromMillis(periodStartSeconds(sub) * 1000),
        currentPeriodEnd: admin.firestore.Timestamp.fromMillis(periodEndSeconds(sub) * 1000),
        cancelAtPeriodEnd: isCancelScheduled(sub),
        stripePromotionCode: isActive ? stripePromotionCode : null,
        lastPaidPlan: lastPaidPlan ?? null,
    });

    if (
        !retainsPlan &&
        !isPastDue &&
        (existing.plan === 'premium' || existing.lastPaidPlan === 'premium' || lastPaidPlan === 'premium') &&
        existing.status !== 'canceled' &&
        existing.status !== 'expired'
    ) {
        const { onFullPremiumAccessEnded } = await import('../email/campaigns');
        void onFullPremiumAccessEnded(uid, sub.id);
    }

    if (retainsPlan && plan === 'premium') {
        const { clearWinbackNeeded } = await import('../email/userStub');
        void clearWinbackNeeded(uid);
    }
}

/**
 * Pull latest subscription state from Stripe into Firestore.
 * Fixes Dashboard cancellations when webhooks did not run (e.g. local dev without stripe listen).
 */
export async function syncUserSubscriptionFromStripe(uid: string): Promise<void> {
    if (!isStripeConfigured()) return;

    const { subscription } = await getUserBillingDoc(uid);
    const customerId = subscription.stripeCustomerId;
    if (!customerId) return;

    const stripe = getStripe();

    if (subscription.stripeSubscriptionId) {
        try {
            const sub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
            // Prefer live paid entitlements. If this id is canceled/past_due, fall through
            // so a newer active subscription (e.g. promo Checkout) wins.
            if (sub.status === 'active' || sub.status === 'trialing') {
                await writeSubscriptionFromStripe(sub as unknown as StripeSubscriptionLike, uid);
                return;
            }
        } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code !== 'resource_missing') {
                console.warn('[billing] sync retrieve subscription failed:', err);
            }
        }
    }

    const list = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 20,
    });

    const preferred =
        list.data.find((s) => s.status === 'active' || s.status === 'trialing') ??
        list.data.find((s) => s.status === 'past_due');
    if (preferred) {
        await writeSubscriptionFromStripe(preferred as unknown as StripeSubscriptionLike, uid);
        return;
    }

    await setSubscription(uid, {
        provider: 'stripe',
        plan: 'free',
        status: 'canceled',
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
        stripePromotionCode: null,
    });
}
