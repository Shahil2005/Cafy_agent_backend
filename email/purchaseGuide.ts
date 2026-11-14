import { resolvePriceDisplayByPriceId } from '../billing/planPricing';
import { getUserBillingDoc, type BillingInterval, type SubscriptionPlan } from '../billing/subscriptionService';
import { enqueuePurchaseGuide } from './campaigns';

function planName(plan: SubscriptionPlan, interval: BillingInterval | null | undefined): string {
    if (plan === 'jobs_premium') {
        return interval === 'monthly' ? 'Jobs Premium Monthly' : 'Jobs Premium Weekly';
    }
    if (interval === 'quarterly') return 'Premium 3-month';
    if (interval === 'monthly') return 'Premium Monthly';
    if (interval === 'weekly') return 'Premium Weekly';
    return 'Premium';
}

function intervalLabel(interval: BillingInterval | null | undefined, pricePeriod: string | null): string {
    if (pricePeriod) return pricePeriod;
    if (interval === 'weekly') return '/week';
    if (interval === 'monthly') return '/month';
    if (interval === 'quarterly') return '/3 months';
    return '';
}

function formatRenewal(date: Date | null): string {
    if (!date) return 'the end of this billing period';
    return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Europe/London',
    });
}

export async function enqueuePurchaseGuideFromSubscription(
    uid: string,
    stripeSubscriptionId: string
): Promise<void> {
    const { subscription } = await getUserBillingDoc(uid);
    const price = subscription.priceId
        ? await resolvePriceDisplayByPriceId(subscription.priceId)
        : null;
    const renewal = subscription.currentPeriodEnd ? subscription.currentPeriodEnd.toDate() : null;

    await enqueuePurchaseGuide(uid, stripeSubscriptionId, {
        planName: planName(subscription.plan, subscription.billingInterval),
        amount: price?.priceDisplay || 'your plan price',
        intervalLabel: intervalLabel(subscription.billingInterval, price?.pricePeriod || null),
        renewalDate: formatRenewal(renewal),
    });
}
