import * as admin from 'firebase-admin';
import { captureServerError } from '../lib/observability/sentry';
import { CAMPAIGN_SPECS, recordCampaignSent, renderCampaignHtml } from './campaigns';
import type { EmailCampaign } from './config';
import { getAppUrl, getResendApiKey, isEmailSendingEnabled, isRecipientAllowed } from './config';
import { claimPendingOutbox, markOutboxFailed, markOutboxSent, markOutboxSkipped } from './outbox';
import { sendWithResend } from './provider';
import { unsubscribeUrlForUser } from './unsubscribe';
import { loadUserEmailProfile } from './userStub';

export async function processEmailOutbox(limit = 20): Promise<{
    claimed: number;
    sent: number;
    skipped: number;
    failed: number;
    reason?: string;
}> {
    if (!isEmailSendingEnabled()) {
        return { claimed: 0, sent: 0, skipped: 0, failed: 0, reason: 'EMAIL_SENDING_ENABLED is not true' };
    }
    if (!getResendApiKey()) {
        return { claimed: 0, sent: 0, skipped: 0, failed: 0, reason: 'RESEND_API_KEY missing' };
    }

    const claimed = await claimPendingOutbox(limit);
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of claimed) {
        const data = item.data;
        const attempts = (typeof data.attempts === 'number' ? data.attempts : 0) + 1;
        try {
            const profile = await loadUserEmailProfile(data.uid);
            const campaign = data.campaign as EmailCampaign;
            const spec = CAMPAIGN_SPECS[campaign];
            if (!spec) {
                await markOutboxSkipped(item.id, `unknown_campaign:${data.campaign}`);
                skipped += 1;
                continue;
            }

            if (!profile.email) {
                await markOutboxSkipped(item.id, 'no_email');
                skipped += 1;
                continue;
            }
            if (spec.marketing && profile.unsubscribed) {
                await markOutboxSkipped(item.id, 'unsubscribed');
                skipped += 1;
                continue;
            }
            if (campaign === 'onboardingReminder' && profile.onboardingCompleted) {
                await markOutboxSkipped(item.id, 'onboarding_completed');
                skipped += 1;
                continue;
            }
            let verifyUrl = '';
            if (campaign === 'verifyReminder') {
                const authUser = await admin.auth().getUser(data.uid);
                if (authUser.emailVerified || !authUser.email) {
                    await markOutboxSkipped(item.id, 'already_verified');
                    skipped += 1;
                    continue;
                }
                verifyUrl = await admin.auth().generateEmailVerificationLink(authUser.email, {
                    url: `${getAppUrl()}/login?verified=true`,
                    handleCodeInApp: false,
                });
            }
            if (
                (campaign === 'premiumEndedNotice' ||
                    campaign === 'winbackPremium' ||
                    campaign === 'freeUsageNotice' ||
                    campaign === 'freeUsageNudge') &&
                profile.fullPremiumActive
            ) {
                await markOutboxSkipped(item.id, 'premium_active');
                skipped += 1;
                continue;
            }
            if (!isRecipientAllowed(profile.email)) {
                await markOutboxSkipped(item.id, 'not_on_allowlist');
                skipped += 1;
                continue;
            }

            let unsubscribeUrl = '';
            try {
                unsubscribeUrl = unsubscribeUrlForUser(data.uid);
            } catch (err) {
                console.warn('[email] unsubscribe token skipped:', err);
            }

            const payload = {
                ...(data.payload || {}),
                first_name: profile.firstName,
                email: profile.email,
                user_id: data.uid,
                unsubscribe_url: unsubscribeUrl,
                verify_url: verifyUrl || String((data.payload || {}).verify_url || `${getAppUrl()}/login`),
                app_url: getAppUrl(),
                year: new Date().getUTCFullYear(),
            };

            const rendered = renderCampaignHtml(campaign, payload);
            const result = await sendWithResend({
                to: profile.email,
                subject: rendered.subject,
                html: rendered.html,
                unsubscribeUrl: spec.marketing && spec.listUnsubscribe !== false ? unsubscribeUrl : undefined,
                tags: [
                    { name: 'campaign', value: campaign },
                    { name: 'uid', value: data.uid },
                ],
            });

            await markOutboxSent(item.id, result.id);
            await recordCampaignSent(data.uid, campaign, item.id, result.id);
            sent += 1;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[email] outbox send failed', item.id, message);
            captureServerError(err, { tags: { area: 'email-outbox' }, extra: { id: item.id } });
            await markOutboxFailed(item.id, message, attempts);
            failed += 1;
        }
    }

    return { claimed: claimed.length, sent, skipped, failed };
}
