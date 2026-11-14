import { getStripe } from './stripeClient';
import { getPartTimeWeeklyPriceId, getWeeklyPriceId } from './config';
import { syncUserSubscriptionFromStripe } from './stripeSubscriptionSync';

/** Stripe subscription metadata keys for in-flight weekly → Full Premium upgrades. */
export const UPGRADE_META = {
    pending: 'cafyWeeklyUpgradePending',
    rollbackPriceId: 'cafyUpgradeRollbackPriceId',
    creditPence: 'cafyUpgradeCreditPence',
    promotionCodeId: 'cafyUpgradePromotionCodeId',
    /** Ties credit + reverse to one upgrade attempt (Stripe idempotency). */
    attemptId: 'cafyUpgradeAttemptId',
} as const;

export type CustomerDebitClearPurpose = 'upgrade' | 'checkout';

function invoiceSubscriptionId(inv: {
    parent?: {
        subscription_details?: { subscription?: string | { id?: string } | null } | null;
    } | null;
    subscription?: string | { id?: string } | null;
}): string | null {
    const fromParent = inv.parent?.subscription_details?.subscription;
    if (typeof fromParent === 'string' && fromParent) return fromParent;
    if (fromParent && typeof fromParent === 'object' && fromParent.id) return fromParent.id;
    const legacy = inv.subscription;
    if (typeof legacy === 'string' && legacy) return legacy;
    if (legacy && typeof legacy === 'object' && legacy.id) return legacy.id;
    return null;
}

export function clearUpgradeMetadataFields(extra?: Record<string, string>): Record<string, string> {
    return {
        [UPGRADE_META.pending]: '',
        [UPGRADE_META.rollbackPriceId]: '',
        [UPGRADE_META.creditPence]: '',
        [UPGRADE_META.promotionCodeId]: '',
        [UPGRADE_META.attemptId]: '',
        ...extra,
    };
}

/**
 * Revert a failed weekly → Full Premium upgrade:
 * void the open invoice, restore weekly price, reverse credit once, clear pending metadata.
 *
 * Safe to call from the upgrade API path and invoice.payment_failed webhooks concurrently:
 * credit reverse uses a Stripe idempotency key keyed by attemptId so a race cannot create
 * two reverse balance transactions (the bug that snowballed customer debit).
 */
export async function rollbackFailedWeeklyUpgrade(params: {
    subscriptionId: string;
    invoiceId?: string | null;
    customerId: string;
    itemId: string;
    weeklyPriceId: string;
    creditPence: number;
    /** Stable id for this upgrade attempt — required for idempotent credit reverse. */
    attemptId: string;
    /** Whether a promo code was attached during the failed attempt — clears it on rollback so a
     * failed upgrade never leaves a discount attached to a subscription that didn't earn it. */
    hadPromotionCode?: boolean;
    uid?: string | null;
}): Promise<{ rolledBack: boolean }> {
    const stripe = getStripe();
    const {
        subscriptionId,
        invoiceId,
        customerId,
        itemId,
        weeklyPriceId,
        creditPence,
        attemptId,
        hadPromotionCode,
        uid,
    } = params;

    if (!attemptId?.trim()) {
        console.error('[billing] upgrade rollback missing attemptId — refusing credit reverse', {
            subscriptionId,
            invoiceId,
            customerId,
        });
    }

    const live = await stripe.subscriptions.retrieve(subscriptionId);
    const meta = (live.metadata || {}) as Record<string, string>;
    if (meta[UPGRADE_META.pending] !== '1') {
        // Another caller already claimed. Still try to void a leftover open invoice.
        if (invoiceId) {
            try {
                await stripe.invoices.voidInvoice(invoiceId);
            } catch (err) {
                console.warn('[billing] void failed upgrade invoice (already rolled back):', invoiceId, err);
            }
        }
        return { rolledBack: false };
    }

    // Void BEFORE switching price. Restoring the source price first can create a new
    // invoice / leave the failed Premium invoice retrying.
    if (invoiceId) {
        try {
            const inv = await stripe.invoices.retrieve(invoiceId);
            if (inv.status === 'paid') {
                console.error('[billing] refusing to rollback — upgrade invoice already paid', {
                    subscriptionId,
                    invoiceId,
                });
                await clearUpgradePendingMetadata(subscriptionId, meta.firebaseUid || uid || undefined);
                return { rolledBack: false };
            }
            if (inv.status === 'open' || inv.status === 'draft' || inv.status === 'uncollectible') {
                await stripe.invoices.voidInvoice(invoiceId);
            }
        } catch (err) {
            console.warn('[billing] void failed upgrade invoice:', invoiceId, err);
        }
    }

    const liveItemId = live.items.data[0]?.id || itemId;
    await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: liveItemId, price: weeklyPriceId }],
        proration_behavior: 'none',
        cancel_at_period_end: false,
        // Pass an explicit empty array only when a discount was actually attached — Stripe
        // treats `discounts: []` as "remove any discounts".
        discounts: hadPromotionCode ? [] : undefined,
        metadata: clearUpgradeMetadataFields({
            firebaseUid: meta.firebaseUid || uid || '',
        }),
    });

    // Voiding restores any applied customer balance (including our unused-credit).
    // Reverse that credit exactly once so the customer does not keep a free credit after failure.
    if (creditPence > 0 && attemptId?.trim()) {
        try {
            await stripe.customers.createBalanceTransaction(
                customerId,
                {
                    amount: creditPence,
                    currency: 'gbp',
                    description: 'Reverse unused weekly credit after failed Full Premium upgrade',
                },
                { idempotencyKey: `career-upgrade-credit-reverse-${attemptId}` }
            );
        } catch (err) {
            console.warn('[billing] reverse upgrade credit failed:', customerId, err);
        }
    }

    if (uid) {
        try {
            await syncUserSubscriptionFromStripe(uid);
        } catch (err) {
            console.warn('[billing] sync after upgrade rollback failed:', uid, err);
        }
    }

    return { rolledBack: true };
}

/**
 * If this payment failure is for a tagged weekly upgrade, roll it back immediately
 * so Stripe stops retrying the full list-price invoice.
 * Returns true when a rollback ran.
 */
export async function rollbackFailedWeeklyUpgradeFromInvoice(invoice: {
    id?: string;
    status?: string | null;
    billing_reason?: string | null;
    parent?: {
        subscription_details?: { subscription?: string | { id?: string } | null } | null;
    } | null;
    subscription?: string | { id?: string } | null;
}): Promise<{ rolledBack: boolean; uid?: string }> {
    // Never unwind a successful charge — stuck pending metadata must not demote Premium.
    if (invoice.status === 'paid') {
        const subscriptionId = invoiceSubscriptionId(invoice);
        if (subscriptionId) {
            await clearUpgradePendingMetadata(subscriptionId);
        }
        return { rolledBack: false };
    }

    if (invoice.billing_reason !== 'subscription_update') {
        return { rolledBack: false };
    }

    const subscriptionId = invoiceSubscriptionId(invoice);
    if (!subscriptionId) {
        return { rolledBack: false };
    }

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const meta = (sub.metadata || {}) as Record<string, string>;
    if (meta[UPGRADE_META.pending] !== '1') {
        return { rolledBack: false };
    }

    const weeklyPriceId =
        meta[UPGRADE_META.rollbackPriceId] || getWeeklyPriceId() || getPartTimeWeeklyPriceId();
    if (!weeklyPriceId) {
        console.warn('[billing] cannot rollback upgrade — source price missing', subscriptionId);
        return { rolledBack: false };
    }

    const itemId = sub.items.data[0]?.id;
    if (!itemId) {
        return { rolledBack: false };
    }

    const creditPence = Math.max(0, parseInt(meta[UPGRADE_META.creditPence] || '0', 10) || 0);
    const attemptId = (meta[UPGRADE_META.attemptId] || '').trim();
    if (!attemptId) {
        console.error('[billing] cannot safely reverse upgrade credit — attemptId missing', {
            subscriptionId,
            invoiceId: invoice.id,
        });
    }
    const hadPromotionCode = Boolean(meta[UPGRADE_META.promotionCodeId]);
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (!customerId) {
        return { rolledBack: false };
    }

    const uid = meta.firebaseUid || undefined;

    const result = await rollbackFailedWeeklyUpgrade({
        subscriptionId,
        invoiceId: invoice.id ?? null,
        customerId,
        itemId,
        weeklyPriceId,
        creditPence,
        attemptId: attemptId || invoice.id || subscriptionId,
        hadPromotionCode,
        uid,
    });

    if (result.rolledBack) {
        console.warn('[billing] rolled back failed weekly upgrade from payment_failed', {
            subscriptionId,
            invoiceId: invoice.id,
            uid,
            attemptId,
        });
    }

    return { rolledBack: result.rolledBack, uid };
}

/**
 * After a successful upgrade payment, drop in-flight upgrade metadata so a later
 * payment_failed webhook cannot demote an already-paid Premium subscription.
 */
export async function clearUpgradePendingMetadata(
    subscriptionId: string,
    firebaseUid?: string
): Promise<void> {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const meta = (sub.metadata || {}) as Record<string, string>;
    if (meta[UPGRADE_META.pending] !== '1' && !meta[UPGRADE_META.attemptId]) {
        return;
    }
    await stripe.subscriptions.update(subscriptionId, {
        metadata: clearUpgradeMetadataFields({
            firebaseUid: firebaseUid || meta.firebaseUid || '',
        }),
    });
}

/**
 * Customer balance is only used for short-lived upgrade unused-time credits.
 * A positive balance means the customer "owes" us and Stripe will add it to the next
 * invoice / Checkout total. Residual debit from failed-upgrade rollbacks must never
 * be collected — wipe it before any charge path (upgrade or Checkout).
 */
export async function clearUnexpectedCustomerDebit(
    customerId: string,
    attemptId: string,
    purpose: CustomerDebitClearPurpose = 'upgrade'
): Promise<{ clearedPence: number }> {
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) {
        return { clearedPence: 0 };
    }

    const balance = customer.balance ?? 0;
    if (balance <= 0) {
        return { clearedPence: 0 };
    }

    console.error('[billing] clearing unexpected customer debit before charge', {
        customerId,
        balancePence: balance,
        attemptId,
        purpose,
    });

    await stripe.customers.createBalanceTransaction(
        customerId,
        {
            amount: -balance,
            currency: 'gbp',
            description:
                purpose === 'checkout'
                    ? 'Clear unexpected customer debit before Checkout'
                    : 'Clear unexpected customer debit before plan upgrade',
        },
        { idempotencyKey: `career-${purpose}-clear-debit-${attemptId}` }
    );

    return { clearedPence: balance };
}

/** @deprecated Use clearUnexpectedCustomerDebit */
export async function clearUnexpectedCustomerDebitBeforeUpgrade(
    customerId: string,
    attemptId: string
): Promise<{ clearedPence: number }> {
    return clearUnexpectedCustomerDebit(customerId, attemptId, 'upgrade');
}
