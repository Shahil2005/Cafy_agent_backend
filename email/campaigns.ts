import * as admin from 'firebase-admin';
import type { EmailCampaign } from './config';
import { getAppUrl, getOfferDelayMs } from './config';
import { interpolateTemplate, loadEmailTemplate } from './render';
import { unsubscribeUrlForUser } from './unsubscribe';
import { enqueueEmail } from './outbox';
import { loadUserEmailProfile, markWinbackNeeded } from './userStub';

export interface CampaignSpec {
    campaign: EmailCampaign;
    filename: string;
    marketing: boolean;
    /** When false, the mail is still opt-out, but Gmail is not given the bulk-mail header. */
    listUnsubscribe?: boolean;
    subject: (vars: Record<string, string | number>) => string;
}

export const CAMPAIGN_SPECS: Record<EmailCampaign, CampaignSpec> = {
    premiumEndedNotice: {
        campaign: 'premiumEndedNotice',
        filename: 'email-1b-premium-ended-notice.html',
        marketing: false,
        subject: () => 'Your Premium access has ended',
    },
    winbackPremium: {
        campaign: 'winbackPremium',
        filename: 'email-1-winback-premium.html',
        marketing: true,
        listUnsubscribe: false,
        subject: (vars) => `Sorry to see you go, ${vars.first_name}`,
    },
    freeUsageNotice: {
        campaign: 'freeUsageNotice',
        filename: 'email-2b-free-usage-notice.html',
        marketing: false,
        subject: (vars) => {
            const remaining = Number(vars.remaining_count);
            if (remaining === 1) return 'You have 1 cover letter left';
            return `You have ${remaining} cover letters left`;
        },
    },
    freeUsageNudge: {
        campaign: 'freeUsageNudge',
        filename: 'email-2-free-to-premium.html',
        marketing: true,
        listUnsubscribe: false,
        subject: () => "You're almost out of Free uses",
    },
    onboardingReminder: {
        campaign: 'onboardingReminder',
        filename: 'email-3-complete-onboarding.html',
        marketing: false,
        subject: (vars) => `Finish setting up your Cafy profile, ${vars.first_name}`,
    },
    purchaseGuide: {
        campaign: 'purchaseGuide',
        filename: 'email-4-purchase-how-billing-works.html',
        marketing: false,
        subject: (vars) => `Your ${vars.plan_name} plan is active`,
    },
    verifyReminder: {
        campaign: 'verifyReminder',
        filename: 'email-5-verify-email.html',
        marketing: false,
        subject: () => 'Verify your email to use Cafy',
    },
};

export function renderCampaignHtml(
    campaign: EmailCampaign,
    vars: Record<string, string | number>
): { html: string; subject: string } {
    const spec = CAMPAIGN_SPECS[campaign];
    const template = loadEmailTemplate(spec.filename);
    return {
        html: interpolateTemplate(template, vars),
        subject: spec.subject(vars),
    };
}

async function commonVars(
    uid: string,
    opts: { requireMarketingOptIn: boolean }
): Promise<{
    profile: Awaited<ReturnType<typeof loadUserEmailProfile>>;
    vars: Record<string, string | number>;
} | null> {
    const profile = await loadUserEmailProfile(uid);
    if (!profile.email) return null;
    if (opts.requireMarketingOptIn && profile.unsubscribed) return null;

    let unsubscribeUrl = '';
    try {
        unsubscribeUrl = unsubscribeUrlForUser(uid);
    } catch (err) {
        console.warn('[email] unsubscribe token skipped:', err);
    }

    return {
        profile,
        vars: {
            first_name: profile.firstName,
            user_id: uid,
            email: profile.email,
            year: new Date().getUTCFullYear(),
            unsubscribe_url: unsubscribeUrl,
            app_url: getAppUrl(),
        },
    };
}

function usagePayload(
    vars: Record<string, string | number>,
    usage: { used: number; limit: number; remaining: number }
): Record<string, string | number> {
    const usagePercent = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
    return {
        ...vars,
        used_count: usage.used,
        limit: usage.limit,
        remaining_count: usage.remaining,
        remaining_plural: usage.remaining === 1 ? '' : 's',
        feature_name: 'cover letters and emails',
        usage_percent: usagePercent,
    };
}

export async function enqueuePremiumEndedNotice(
    uid: string,
    stripeSubscriptionId?: string | null
): Promise<void> {
    const common = await commonVars(uid, { requireMarketingOptIn: false });
    if (!common) return;

    await enqueueEmail({
        campaign: 'premiumEndedNotice',
        uid,
        to: common.profile.email!,
        payload: common.vars,
        idempotencyKey: `premiumEndedNotice:${uid}:${stripeSubscriptionId || 'unknown'}`,
    });
}

export async function enqueueWinbackPremium(
    uid: string,
    stripeSubscriptionId?: string | null,
    opts?: { delayMs?: number }
): Promise<void> {
    const common = await commonVars(uid, { requireMarketingOptIn: true });
    if (!common) return;

    const delayMs = opts?.delayMs ?? getOfferDelayMs();
    await enqueueEmail({
        campaign: 'winbackPremium',
        uid,
        to: common.profile.email!,
        payload: common.vars,
        idempotencyKey: `winbackPremium:${uid}:${stripeSubscriptionId || 'unknown'}`,
        sendAfterMs: Date.now() + delayMs,
    });
}

export async function enqueuePremiumEndedPair(
    uid: string,
    stripeSubscriptionId?: string | null
): Promise<void> {
    await enqueuePremiumEndedNotice(uid, stripeSubscriptionId);
    await enqueueWinbackPremium(uid, stripeSubscriptionId);
}

export async function onFullPremiumAccessEnded(
    uid: string,
    stripeSubscriptionId?: string | null
): Promise<void> {
    try {
        await markWinbackNeeded(uid, 'premium', stripeSubscriptionId);
        await enqueuePremiumEndedPair(uid, stripeSubscriptionId);
    } catch (err) {
        console.error('[email] winback enqueue failed:', err);
    }
}

export async function enqueueFreeUsageNotice(
    uid: string,
    usage: { used: number; limit: number; remaining: number }
): Promise<void> {
    const common = await commonVars(uid, { requireMarketingOptIn: false });
    if (!common) return;

    await enqueueEmail({
        campaign: 'freeUsageNotice',
        uid,
        to: common.profile.email!,
        payload: usagePayload(common.vars, usage),
        idempotencyKey: `freeUsageNotice:${uid}`,
    });
}

export async function enqueueFreeUsageNudge(
    uid: string,
    usage: { used: number; limit: number; remaining: number },
    opts?: { delayMs?: number }
): Promise<void> {
    const common = await commonVars(uid, { requireMarketingOptIn: true });
    if (!common) return;

    const delayMs = opts?.delayMs ?? getOfferDelayMs();
    await enqueueEmail({
        campaign: 'freeUsageNudge',
        uid,
        to: common.profile.email!,
        payload: usagePayload(common.vars, usage),
        idempotencyKey: `freeUsageNudge:${uid}`,
        sendAfterMs: Date.now() + delayMs,
    });
}

export async function enqueueFreeUsagePair(
    uid: string,
    usage: { used: number; limit: number; remaining: number }
): Promise<void> {
    await enqueueFreeUsageNotice(uid, usage);
    await enqueueFreeUsageNudge(uid, usage);
}

export async function enqueuePurchaseGuide(
    uid: string,
    stripeSubscriptionId: string,
    details: {
        planName: string;
        amount: string;
        intervalLabel: string;
        renewalDate: string;
    }
): Promise<void> {
    const common = await commonVars(uid, { requireMarketingOptIn: false });
    if (!common) return;

    await enqueueEmail({
        campaign: 'purchaseGuide',
        uid,
        to: common.profile.email!,
        payload: {
            ...common.vars,
            plan_name: details.planName,
            amount: details.amount,
            interval_label: details.intervalLabel,
            renewal_date: details.renewalDate,
        },
        idempotencyKey: `purchaseGuide:${uid}:${stripeSubscriptionId}`,
    });
}

export async function enqueueVerifyReminder(uid: string): Promise<void> {
    const common = await commonVars(uid, { requireMarketingOptIn: false });
    if (!common) return;

    await enqueueEmail({
        campaign: 'verifyReminder',
        uid,
        to: common.profile.email!,
        payload: {
            ...common.vars,
            verify_url: `${getAppUrl()}/login`,
        },
        idempotencyKey: `verifyReminder:${uid}`,
    });
}

export async function enqueueOnboardingReminder(uid: string): Promise<void> {
    const common = await commonVars(uid, { requireMarketingOptIn: false });
    if (!common) return;
    if (common.profile.onboardingCompleted) return;

    await enqueueEmail({
        campaign: 'onboardingReminder',
        uid,
        to: common.profile.email!,
        payload: common.vars,
        idempotencyKey: `onboardingReminder:${uid}`,
    });
}

export async function recordCampaignSent(
    uid: string,
    campaign: EmailCampaign,
    outboxId: string,
    providerMessageId: string | null
): Promise<void> {
    const now = admin.firestore.FieldValue.serverTimestamp();
    const campaignPatch: Record<string, unknown> = {
        [`emails.campaigns.${campaign}.sentAt`]: now,
        [`emails.campaigns.${campaign}.outboxId`]: outboxId,
        [`emails.campaigns.${campaign}.providerMessageId`]: providerMessageId,
    };
    if (campaign === 'onboardingReminder') {
        campaignPatch['emails.needsOnboardingReminder'] = false;
    }
    if (campaign === 'winbackPremium') {
        campaignPatch['emails.needsWinback'] = false;
    }

    await admin.firestore().doc(`users/${uid}`).set(campaignPatch, { merge: true });
    await admin.firestore().doc(`users/${uid}/emailSends/${campaign}`).set(
        {
            campaign,
            outboxId,
            providerMessageId,
            sentAt: now,
        },
        { merge: true }
    );
}
