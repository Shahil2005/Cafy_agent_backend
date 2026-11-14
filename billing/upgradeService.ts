import { randomUUID } from 'crypto';
import { getStripe, isStripeConfigured } from './stripeClient';
import {
    refreshSubscriptionIfExpired,
    isFullPremiumActive,
} from './subscriptionService';
import {
    isFullPremiumPriceId,
    isJobsMonthlyPriceId,
    isJobsWeeklyEnabled,
    isPartTimeWeeklyEnabled,
    isWeeklyPriceId,
    priceIdToInterval,
} from './config';
import { getStripePlanPrices } from './planPricing';
import { syncUserSubscriptionFromStripe } from './stripeSubscriptionSync';
import {
    clearUnexpectedCustomerDebit,
    clearUpgradePendingMetadata,
    rollbackFailedWeeklyUpgrade,
    UPGRADE_META,
} from './upgradeRollback';
import { resolveActivePromotionCodeId, type PromoCouponDuration } from './promotionCodeResolve';

/**
 * A promo code was typed but does not resolve to an active Stripe promotion code
 * (invalid, expired, or fully redeemed). Hard-fail — never silently charge full price
 * when the user explicitly expected a discount to apply.
 */
export class InvalidPromoCodeError extends Error {
    constructor() {
        super('This promo code is not valid, has expired, or has already been used.');
        this.name = 'InvalidPromoCodeError';
    }
}

/** Billing period length for Jobs Premium Weekly (used for unused-day credit). */
export const JOBS_WEEKLY_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export type WeeklyUpgradePaymentErrorCode =
    | 'PAYMENT_ACTION_REQUIRED'
    | 'UPGRADE_PAYMENT_FAILED'
    | 'UPGRADE_AMOUNT_MISMATCH';

export class WeeklyUpgradePaymentError extends Error {
    readonly code: WeeklyUpgradePaymentErrorCode;
    readonly hostedInvoiceUrl: string | null;

    constructor(
        code: WeeklyUpgradePaymentErrorCode,
        hostedInvoiceUrl?: string | null,
        message?: string
    ) {
        const defaultMessage =
            code === 'PAYMENT_ACTION_REQUIRED'
                ? 'Your bank requires extra verification to complete this payment.'
                : code === 'UPGRADE_AMOUNT_MISMATCH'
                  ? 'The charge amount did not match the upgrade quote. No unexpected charge was kept.'
                  : 'We could not charge your saved payment method.';
        super(message ?? defaultMessage);
        this.name = 'WeeklyUpgradePaymentError';
        this.code = code;
        this.hostedInvoiceUrl = hostedInvoiceUrl ?? null;
    }
}

export interface WeeklyUpgradeCreditBreakdown {
    usedDays: number;
    remainingDays: number;
    creditGBP: number;
    creditPence: number;
}

export function calculateUnusedPeriodCredit(
    periodStartMs: number,
    periodEndMs: number,
    pricePence: number,
    nowMs = Date.now()
): WeeklyUpgradeCreditBreakdown {
    const periodDays = Math.max(1, Math.ceil((periodEndMs - periodStartMs) / MS_PER_DAY));
    const elapsedMs = Math.max(0, nowMs - periodStartMs);
    const usedDays = Math.min(periodDays, Math.max(1, Math.ceil(elapsedMs / MS_PER_DAY)));
    const remainingDays = Math.max(0, periodDays - usedDays);
    const creditPence =
        remainingDays <= 0 || pricePence <= 0
            ? 0
            : Math.round((pricePence / periodDays) * remainingDays);
    const creditGBP = creditPence / 100;
    return { usedDays, remainingDays, creditGBP, creditPence };
}

export function calculateWeeklyUpgradeCredit(
    periodStartMs: number,
    weeklyPricePence: number,
    nowMs = Date.now()
): WeeklyUpgradeCreditBreakdown {
    return calculateUnusedPeriodCredit(
        periodStartMs,
        periodStartMs + JOBS_WEEKLY_DAYS * MS_PER_DAY,
        weeklyPricePence,
        nowMs
    );
}

function formatGbp(amount: number): string {
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);
}

function resolvePeriodBounds(subscription: {
    currentPeriodStart?: { toMillis(): number } | null;
    currentPeriodEnd?: { toMillis(): number } | null;
    billingInterval?: string | null;
}): { startMs: number; endMs: number } {
    const now = Date.now();
    const startMs = subscription.currentPeriodStart?.toMillis() ?? now;
    if (subscription.currentPeriodEnd) {
        return { startMs, endMs: subscription.currentPeriodEnd.toMillis() };
    }
    const fallbackDays =
        subscription.billingInterval === 'monthly' ? 30 : JOBS_WEEKLY_DAYS;
    return { startMs, endMs: startMs + fallbackDays * MS_PER_DAY };
}

function isJobsMonthlySubscriber(subscription: { billingInterval?: string | null; plan?: string | null }): boolean {
    return subscription.plan === 'jobs_premium' && subscription.billingInterval === 'monthly';
}

function isPartTimeSubscriber(subscription: { plan?: string | null }): boolean {
    return subscription.plan === 'part_time';
}

function isValidJobsUpgradeTarget(
    subscription: { billingInterval?: string | null; priceId?: string | null; plan?: string | null },
    targetPriceId: string
): boolean {
    if (subscription.priceId && subscription.priceId === targetPriceId) {
        return false;
    }
    const targetingJobsWeekly = isWeeklyPriceId(targetPriceId);
    const targetingJobsMonthly = isJobsMonthlyPriceId(targetPriceId);
    const targetingFullPremium = isFullPremiumPriceId(targetPriceId);

    if (isPartTimeSubscriber(subscription)) {
        return targetingJobsWeekly || targetingJobsMonthly || targetingFullPremium;
    }

    if (!targetingJobsMonthly && !targetingFullPremium) {
        return false;
    }
    // Jobs monthly can only move up to Full Premium (monthly or quarterly).
    if (isJobsMonthlySubscriber(subscription)) {
        return targetingFullPremium;
    }
    // Jobs weekly can move to jobs monthly, Premium monthly, or Premium quarterly.
    return true;
}

async function assertUpgradeableSubscriber(uid: string) {
    if (!isStripeConfigured()) {
        throw new Error('STRIPE_NOT_CONFIGURED');
    }

    const subscription = await refreshSubscriptionIfExpired(uid);
    if (isFullPremiumActive(subscription)) {
        throw new Error('ALREADY_FULL_PREMIUM');
    }
    if (subscription.status !== 'active') {
        throw new Error('NOT_ACTIVE_SUBSCRIPTION');
    }
    if (!subscription.stripeSubscriptionId || !subscription.stripeCustomerId) {
        throw new Error('NO_STRIPE_SUBSCRIPTION');
    }

    if (subscription.plan === 'part_time') {
        if (!isPartTimeWeeklyEnabled()) {
            throw new Error('PART_TIME_WEEKLY_DISABLED');
        }
        return subscription;
    }

    if (subscription.plan === 'jobs_premium') {
        if (!isJobsWeeklyEnabled()) {
            throw new Error('JOBS_WEEKLY_DISABLED');
        }
        return subscription;
    }

    throw new Error('NOT_UPGRADEABLE_PLAN');
}

/** @deprecated Prefer assertUpgradeableSubscriber — kept for call-site clarity. */
async function assertJobsPremiumSubscriber(uid: string) {
    return assertUpgradeableSubscriber(uid);
}

interface StripeInvoiceLike {
    id?: string;
    status?: string | null;
    amount_due?: number;
    amount_paid?: number;
    total?: number;
    starting_balance?: number;
    hosted_invoice_url?: string | null;
    payment_intent?: string | { id?: string; status?: string; latest_charge?: string | { id?: string } | null } | null;
    charge?: string | { id?: string } | null;
}

/** Allow 1p rounding drift only — anything above is treated as an unexpected overcharge. */
const UPGRADE_AMOUNT_TOLERANCE_PENCE = 1;

async function voidOtherOpenInvoicesForSubscription(
    stripe: ReturnType<typeof getStripe>,
    customerId: string,
    subscriptionId: string
): Promise<void> {
    const openInvoices = await stripe.invoices.list({
        customer: customerId,
        status: 'open',
        limit: 20,
    });
    for (const inv of openInvoices.data) {
        const fromParent = inv.parent?.subscription_details?.subscription;
        const invSub =
            typeof fromParent === 'string'
                ? fromParent
                : fromParent && typeof fromParent === 'object'
                  ? fromParent.id ?? null
                  : null;
        // Only void invoices tied to this subscription (or legacy invoices with no parent link).
        if (invSub && invSub !== subscriptionId) continue;
        if (!invSub) continue;
        try {
            await stripe.invoices.voidInvoice(inv.id);
            console.warn('[billing] voided leftover open invoice before upgrade', {
                invoiceId: inv.id,
                subscriptionId,
            });
        } catch (err) {
            console.warn('[billing] could not void leftover open invoice before upgrade:', inv.id, err);
        }
    }
}

function assertInvoiceAmountMatchesQuote(
    invoice: StripeInvoiceLike,
    expectedAmountDuePence: number,
    phase: 'pre_charge' | 'post_charge'
): void {
    const actual =
        phase === 'post_charge'
            ? (invoice.amount_paid ?? invoice.amount_due ?? 0)
            : (invoice.amount_due ?? 0);
    if (actual > expectedAmountDuePence + UPGRADE_AMOUNT_TOLERANCE_PENCE) {
        console.error('[billing] upgrade amount mismatch', {
            phase,
            invoiceId: invoice.id,
            expectedAmountDuePence,
            actualPence: actual,
            total: invoice.total,
            starting_balance: invoice.starting_balance,
        });
        throw new WeeklyUpgradePaymentError(
            'UPGRADE_AMOUNT_MISMATCH',
            invoice.hosted_invoice_url ?? null,
            phase === 'pre_charge'
                ? 'Upgrade quote did not match the invoice Stripe prepared. No charge was taken.'
                : 'Upgrade was charged more than quoted. Extra amount will be refunded.'
        );
    }
}

async function refundUpgradeOverchargeIfNeeded(
    stripe: ReturnType<typeof getStripe>,
    invoice: StripeInvoiceLike,
    expectedAmountDuePence: number,
    attemptId: string
): Promise<number> {
    const paid = invoice.amount_paid ?? 0;
    const overcharge = paid - expectedAmountDuePence;
    if (overcharge <= UPGRADE_AMOUNT_TOLERANCE_PENCE) {
        return 0;
    }

    let chargeId: string | null =
        typeof invoice.charge === 'string'
            ? invoice.charge
            : invoice.charge && typeof invoice.charge === 'object'
              ? invoice.charge.id ?? null
              : null;

    if (!chargeId && invoice.payment_intent) {
        const piId =
            typeof invoice.payment_intent === 'string'
                ? invoice.payment_intent
                : invoice.payment_intent.id;
        if (piId) {
            const pi = await stripe.paymentIntents.retrieve(piId);
            const latest = pi.latest_charge;
            chargeId = typeof latest === 'string' ? latest : latest?.id ?? null;
        }
    }

    if (!chargeId) {
        console.error('[billing] overcharge detected but no charge id to refund', {
            invoiceId: invoice.id,
            overcharge,
            attemptId,
        });
        throw new WeeklyUpgradePaymentError(
            'UPGRADE_AMOUNT_MISMATCH',
            invoice.hosted_invoice_url ?? null,
            'Upgrade overcharge detected but automatic refund could not be started. Contact support.'
        );
    }

    await stripe.refunds.create(
        {
            charge: chargeId,
            amount: overcharge,
            reason: 'duplicate',
            metadata: {
                cafyReason: 'upgrade_amount_mismatch',
                attemptId,
                invoiceId: invoice.id || '',
            },
        },
        { idempotencyKey: `career-upgrade-overcharge-refund-${attemptId}` }
    );

    console.error('[billing] refunded upgrade overcharge', {
        invoiceId: invoice.id,
        chargeId,
        overchargePence: overcharge,
        attemptId,
    });

    return overcharge;
}

interface StripeSubscriptionUpdateLike {
    id: string;
    latest_invoice?: string | StripeInvoiceLike | null;
}

async function resolveLatestUpgradeInvoice(
    stripe: ReturnType<typeof getStripe>,
    updatedSub: StripeSubscriptionUpdateLike
): Promise<StripeInvoiceLike> {
    let invoiceId =
        typeof updatedSub.latest_invoice === 'string'
            ? updatedSub.latest_invoice
            : updatedSub.latest_invoice?.id ?? null;

    if (!invoiceId) {
        const list = await stripe.invoices.list({
            subscription: updatedSub.id,
            limit: 1,
        });
        invoiceId = list.data[0]?.id ?? null;
    }

    if (!invoiceId) {
        throw new WeeklyUpgradePaymentError(
            'UPGRADE_PAYMENT_FAILED',
            null,
            'Could not find the upgrade invoice.'
        );
    }

    return stripe.invoices.retrieve(invoiceId, { expand: ['payment_intent'] }) as Promise<StripeInvoiceLike>;
}

async function waitForUpgradeInvoicePayment(
    stripe: ReturnType<typeof getStripe>,
    invoice: StripeInvoiceLike
): Promise<StripeInvoiceLike> {
    if (invoice.status === 'paid' || invoice.amount_due === 0) {
        return invoice;
    }

    const pi = invoice.payment_intent;
    const piStatus = typeof pi === 'object' && pi !== null ? pi.status : null;
    if (piStatus !== 'processing' || !invoice.id) {
        return invoice;
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
    return stripe.invoices.retrieve(invoice.id, { expand: ['payment_intent'] }) as Promise<StripeInvoiceLike>;
}

function assertUpgradeInvoicePaid(invoice: StripeInvoiceLike): void {
    if (invoice.status === 'paid' || invoice.amount_due === 0) {
        return;
    }

    const hostedInvoiceUrl = invoice.hosted_invoice_url ?? null;
    const pi = invoice.payment_intent;
    const piStatus = typeof pi === 'object' && pi !== null ? pi.status : null;

    if (invoice.status === 'open' && piStatus === 'requires_action') {
        throw new WeeklyUpgradePaymentError('PAYMENT_ACTION_REQUIRED', hostedInvoiceUrl);
    }

    throw new WeeklyUpgradePaymentError('UPGRADE_PAYMENT_FAILED', hostedInvoiceUrl);
}

/**
 * Resolves a typed promo code (if any) and, when valid, asks Stripe's own invoice-preview
 * engine what the new-plan invoice would actually total after that discount — never hand-computed
 * percentage/amount math on our side, so the number shown can never drift from what Stripe charges.
 * Returns `{ promotionCodeId: null, ... }` when no code was given; throws InvalidPromoCodeError
 * when a code was given but does not resolve to an active Stripe promotion code.
 */
interface DiscountedTargetResult {
    promotionCodeId: string | null;
    resolvedCode: string | null;
    discountedTotalPence: number;
    duration: PromoCouponDuration | null;
    durationInMonths: number | null;
}

async function resolveDiscountedTarget(
    stripe: ReturnType<typeof getStripe>,
    subscription: { stripeSubscriptionId?: string | null; stripeCustomerId?: string | null },
    targetPriceId: string,
    targetListPricePence: number,
    promoCode?: string | null
): Promise<DiscountedTargetResult> {
    if (!promoCode || !promoCode.trim()) {
        return {
            promotionCodeId: null,
            resolvedCode: null,
            discountedTotalPence: targetListPricePence,
            duration: null,
            durationInMonths: null,
        };
    }

    const resolved = await resolveActivePromotionCodeId(promoCode);
    if (!resolved) {
        throw new InvalidPromoCodeError();
    }

    const subscriptionId = subscription.stripeSubscriptionId!;
    const customerId = subscription.stripeCustomerId!;
    const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
    const itemId = stripeSub.items.data[0]?.id;
    if (!itemId) {
        throw new Error('SUBSCRIPTION_ITEM_MISSING');
    }

    const previewInvoice = await stripe.invoices.createPreview({
        customer: customerId,
        subscription: subscriptionId,
        discounts: [{ promotion_code: resolved.promotionCodeId }],
        subscription_details: {
            items: [{ id: itemId, price: targetPriceId }],
            proration_behavior: 'none',
            billing_cycle_anchor: 'now',
        },
    });

    return {
        promotionCodeId: resolved.promotionCodeId,
        resolvedCode: resolved.code,
        discountedTotalPence: Math.max(0, previewInvoice.total),
        duration: resolved.duration,
        durationInMonths: resolved.durationInMonths,
    };
}

export async function previewWeeklyUpgrade(uid: string, targetPriceId: string, promoCode?: string | null) {
    const subscription = await assertUpgradeableSubscriber(uid);
    if (!isValidJobsUpgradeTarget(subscription, targetPriceId)) {
        throw new Error('INVALID_UPGRADE_TARGET');
    }

    const { startMs, endMs } = resolvePeriodBounds(subscription);
    const prices = await getStripePlanPrices();
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId!);
    const currentPricePence = stripeSub.items.data[0]?.price?.unit_amount ?? null;
    const catalogCurrentPence =
        subscription.plan === 'part_time'
            ? prices.partTimeWeekly?.unitAmountMinor
            : subscription.billingInterval === 'monthly'
              ? prices.jobsMonthly?.unitAmountMinor
              : prices.weekly?.unitAmountMinor;
    const pricePence = currentPricePence ?? catalogCurrentPence;
    if (!pricePence) {
        throw new Error('SOURCE_PRICE_UNAVAILABLE');
    }

    const credit = calculateUnusedPeriodCredit(startMs, endMs, pricePence);
    const isJobsWeeklyTarget = isWeeklyPriceId(targetPriceId);
    const isJobsMonthlyTarget = isJobsMonthlyPriceId(targetPriceId);
    const target = isJobsWeeklyTarget
        ? prices.weekly
        : isJobsMonthlyTarget
          ? prices.jobsMonthly
          : priceIdToInterval(targetPriceId) === 'quarterly'
            ? prices.quarterly
            : prices.monthly;

    if (!target?.unitAmountMinor) {
        throw new Error('TARGET_PRICE_UNAVAILABLE');
    }

    // Promo only when upgrading to Full Premium — never on jobs weekly/monthly targets
    // (including upgrades from part-time).
    const promoForTarget = isFullPremiumPriceId(targetPriceId) ? promoCode : null;
    const discounted = await resolveDiscountedTarget(
        stripe,
        subscription,
        targetPriceId,
        target.unitAmountMinor,
        promoForTarget
    );

    const targetAmountGBP = target.unitAmountMinor / 100;
    const discountAppliedPence = Math.max(0, target.unitAmountMinor - discounted.discountedTotalPence);
    const discountAppliedGBP = discountAppliedPence / 100;
    const amountDuePence = Math.max(0, discounted.discountedTotalPence - credit.creditPence);
    const amountDueGBP = amountDuePence / 100;
    const targetPlan = isJobsWeeklyTarget
        ? 'weekly'
        : isJobsMonthlyTarget
          ? 'jobs_monthly'
          : priceIdToInterval(targetPriceId) === 'quarterly'
            ? 'quarterly'
            : 'monthly';

    const promoRecurs = discounted.duration === 'repeating' || discounted.duration === 'forever';
    const recurringAmountPence = promoRecurs ? discounted.discountedTotalPence : target.unitAmountMinor;
    const recurringAmountGBP = recurringAmountPence / 100;
    const periodDays = Math.max(1, Math.ceil((endMs - startMs) / MS_PER_DAY));

    return {
        targetPlan,
        targetPriceId,
        targetAmountGBP,
        targetAmountDisplay: target.priceDisplay,
        targetPeriod: target.pricePeriod,
        promoCode: discounted.resolvedCode,
        promotionCodeId: discounted.promotionCodeId,
        promoDuration: discounted.duration,
        promoDurationInMonths: discounted.durationInMonths,
        discountAppliedGBP,
        discountAppliedDisplay: discounted.promotionCodeId ? formatGbp(discountAppliedGBP) : null,
        creditGBP: credit.creditGBP,
        creditPence: credit.creditPence,
        creditDisplay: formatGbp(credit.creditGBP),
        amountDueGBP,
        amountDueDisplay: formatGbp(amountDueGBP),
        recurringAmountGBP,
        recurringAmountDisplay: formatGbp(recurringAmountGBP),
        usedDays: credit.usedDays,
        remainingDays: credit.remainingDays,
        weeklyDaysTotal: periodDays,
        sourcePlan: subscription.plan,
    };
}

export async function executeWeeklyUpgrade(uid: string, targetPriceId: string, promoCode?: string | null) {
    const subscription = await assertUpgradeableSubscriber(uid);
    if (!isValidJobsUpgradeTarget(subscription, targetPriceId)) {
        throw new Error('INVALID_UPGRADE_TARGET');
    }

    const preview = await previewWeeklyUpgrade(uid, targetPriceId, promoCode);
    const stripe = getStripe();
    const customerId = subscription.stripeCustomerId!;
    const subscriptionId = subscription.stripeSubscriptionId!;
    const rollbackPriceId = subscription.priceId;
    if (!rollbackPriceId) {
        throw new Error('SOURCE_PRICE_UNAVAILABLE');
    }

    const attemptId = randomUUID();
    const expectedAmountDuePence = Math.round(preview.amountDueGBP * 100);
    const creditDescription = isPartTimeSubscriber(subscription)
        ? 'Part-time unused credit (plan upgrade)'
        : isJobsMonthlyPriceId(targetPriceId)
          ? 'Jobs Premium unused credit (upgrade to Jobs Monthly)'
          : 'Jobs Premium unused credit (upgrade to Full Premium)';

    // Block overlapping upgrade attempts (double-click / parallel requests).
    const existingSub = await stripe.subscriptions.retrieve(subscriptionId);
    const existingMeta = (existingSub.metadata || {}) as Record<string, string>;
    if (existingMeta[UPGRADE_META.pending] === '1') {
        throw new Error('UPGRADE_IN_PROGRESS');
    }

    // Drop any leftover open invoices so Stripe cannot collect an old failed upgrade bill.
    await voidOtherOpenInvoicesForSubscription(stripe, customerId, subscriptionId);

    // Positive customer balance is added onto the next invoice. Residual debit from a
    // prior failed-upgrade double-rollback must never be collected on a successful pay.
    await clearUnexpectedCustomerDebit(customerId, attemptId, 'upgrade');

    if (preview.creditPence > 0) {
        await stripe.customers.createBalanceTransaction(
            customerId,
            {
                amount: -preview.creditPence,
                currency: 'gbp',
                description: creditDescription,
            },
            { idempotencyKey: `career-upgrade-credit-${attemptId}` }
        );
    }

    const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
    const itemId = stripeSub.items.data[0]?.id;
    if (!itemId) {
        throw new Error('SUBSCRIPTION_ITEM_MISSING');
    }

    const updated = await stripe.subscriptions.update(
        subscriptionId,
        {
            items: [{ id: itemId, price: targetPriceId }],
            proration_behavior: 'none',
            billing_cycle_anchor: 'now',
            cancel_at_period_end: false,
            discounts: preview.promotionCodeId ? [{ promotion_code: preview.promotionCodeId }] : undefined,
            metadata: {
                firebaseUid: uid,
                [UPGRADE_META.pending]: '1',
                [UPGRADE_META.rollbackPriceId]: rollbackPriceId,
                [UPGRADE_META.creditPence]: String(preview.creditPence),
                [UPGRADE_META.promotionCodeId]: preview.promotionCodeId ?? '',
                [UPGRADE_META.attemptId]: attemptId,
            },
            expand: ['latest_invoice.payment_intent'],
        },
        { idempotencyKey: `career-upgrade-switch-${attemptId}` }
    );

    let invoice = await resolveLatestUpgradeInvoice(stripe, updated);

    // Abort before / instead of collecting if Stripe's invoice is higher than the quote.
    try {
        if (invoice.status !== 'paid') {
            assertInvoiceAmountMatchesQuote(invoice, expectedAmountDuePence, 'pre_charge');
        }
    } catch (err) {
        try {
            await rollbackFailedWeeklyUpgrade({
                subscriptionId,
                invoiceId: invoice.id ?? null,
                customerId,
                itemId,
                weeklyPriceId: rollbackPriceId,
                creditPence: preview.creditPence,
                attemptId,
                hadPromotionCode: Boolean(preview.promotionCodeId),
                uid,
            });
        } catch (rollbackErr) {
            console.error('[billing] upgrade amount-mismatch rollback failed:', rollbackErr);
        }
        throw err;
    }

    try {
        invoice = await waitForUpgradeInvoicePayment(stripe, invoice);
        assertUpgradeInvoicePaid(invoice);
    } catch (err) {
        // 3DS / bank action: keep Premium+pending and the open invoice so the customer can finish.
        // payment_failed webhook rolls back if they abandon; invoice.paid clears pending on success.
        if (err instanceof WeeklyUpgradePaymentError && err.code === 'PAYMENT_ACTION_REQUIRED') {
            throw err;
        }
        try {
            await rollbackFailedWeeklyUpgrade({
                subscriptionId,
                invoiceId: invoice.id ?? null,
                customerId,
                itemId,
                weeklyPriceId: rollbackPriceId,
                creditPence: preview.creditPence,
                attemptId,
                hadPromotionCode: Boolean(preview.promotionCodeId),
                uid,
            });
        } catch (rollbackErr) {
            console.error('[billing] upgrade payment failure rollback failed:', rollbackErr);
        }
        throw err;
    }

    // If somehow paid more than quoted, refund the delta immediately.
    try {
        assertInvoiceAmountMatchesQuote(invoice, expectedAmountDuePence, 'post_charge');
    } catch (err) {
        await refundUpgradeOverchargeIfNeeded(stripe, invoice, expectedAmountDuePence, attemptId);
        // Still succeed the upgrade at the quoted net; overcharge is refunded.
        if (!(err instanceof WeeklyUpgradePaymentError && err.code === 'UPGRADE_AMOUNT_MISMATCH')) {
            throw err;
        }
    }

    // Clear pending before any further work so payment_failed cannot demote a paid upgrade.
    await clearUpgradePendingMetadata(subscriptionId, uid);

    // Belt-and-suspenders: never leave a residual debit after a successful upgrade charge.
    try {
        await clearUnexpectedCustomerDebit(customerId, `${attemptId}-post`, 'upgrade');
    } catch (err) {
        console.error('[billing] post-upgrade debit clear failed:', customerId, err);
    }

    await syncUserSubscriptionFromStripe(uid);

    return {
        ok: true as const,
        creditAppliedGBP: preview.creditGBP,
        creditDisplay: preview.creditDisplay,
        promoCode: preview.promoCode,
        discountAppliedGBP: preview.discountAppliedGBP,
        discountAppliedDisplay: preview.discountAppliedDisplay,
        amountDueGBP: preview.amountDueGBP,
        amountDueDisplay: preview.amountDueDisplay,
        targetPlan: preview.targetPlan,
    };
}
