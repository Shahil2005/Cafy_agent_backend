/**
 * One-off: send lifecycle templates to EMAIL_ALLOWLIST.
 * Does not change the user's plan, usage, or onboarding flags.
 *
 *   npx ts-node scripts/sendTestLifecycleEmails.ts
 *   npx ts-node scripts/sendTestLifecycleEmails.ts status
 *   npx ts-node scripts/sendTestLifecycleEmails.ts offers
 *   npx ts-node scripts/sendTestLifecycleEmails.ts all
 */
import '../env';
import * as admin from 'firebase-admin';
import { CAMPAIGN_SPECS, renderCampaignHtml } from '../email/campaigns';
import type { EmailCampaign } from '../email/config';
import { getAppUrl, getEmailAllowlist, getEmailFrom } from '../email/config';
import { firstNameFromDisplayName } from '../email/names';
import { sendWithResend } from '../email/provider';
import { unsubscribeUrlForUser } from '../email/unsubscribe';

function initAdmin(): void {
    if (admin.apps.length) return;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
    const serviceAccount = JSON.parse(raw) as admin.ServiceAccount;
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

async function main(): Promise<void> {
    const allowlist = getEmailAllowlist();
    const to = allowlist[0];
    if (!to) {
        throw new Error('Set EMAIL_ALLOWLIST to your inbox before running this script');
    }

    const mode = (process.argv[2] || 'status').toLowerCase();
    const includeStatus = mode === 'status' || mode === 'all';
    const includeOffers = mode === 'offers' || mode === 'all';
    const includeWinback = mode === 'winback' || includeOffers;
    const includeOnboarding = mode === 'onboarding' || mode === 'all';
    const includePurchase = mode === 'purchase' || mode === 'all';
    const includeVerify = mode === 'verify' || mode === 'all';
    if (!includeStatus && !includeOffers && !includeWinback && !includeOnboarding && !includePurchase && !includeVerify) {
        throw new Error('Usage: sendTestLifecycleEmails.ts [status|offers|winback|onboarding|purchase|verify|all]');
    }

    initAdmin();
    const authUser = await admin.auth().getUserByEmail(to);
    const firstName = firstNameFromDisplayName(authUser.displayName);
    const unsubscribeUrl = unsubscribeUrlForUser(authUser.uid);

    const base = {
        first_name: firstName,
        user_id: authUser.uid,
        email: to,
        year: new Date().getUTCFullYear(),
        unsubscribe_url: unsubscribeUrl,
        app_url: getAppUrl(),
    };

    const usage = {
        ...base,
        used_count: 4,
        limit: 5,
        remaining_count: 1,
        remaining_plural: '',
        feature_name: 'cover letters and emails',
        usage_percent: 80,
    };

    const jobs: Array<{ campaign: EmailCampaign; payload: Record<string, string | number> }> = [];
    if (includeStatus) {
        jobs.push({ campaign: 'premiumEndedNotice', payload: base });
        jobs.push({ campaign: 'freeUsageNotice', payload: usage });
    }
    if (includeWinback) {
        jobs.push({ campaign: 'winbackPremium', payload: base });
    }
    if (includeOffers) {
        jobs.push({ campaign: 'freeUsageNudge', payload: usage });
    }
    if (includeOnboarding) {
        jobs.push({ campaign: 'onboardingReminder', payload: base });
    }
    if (includePurchase) {
        jobs.push({
            campaign: 'purchaseGuide',
            payload: {
                ...base,
                plan_name: 'Premium Monthly',
                amount: '£25',
                interval_label: '/month',
                renewal_date: '25 October 2026',
            },
        });
    }
    if (includeVerify) {
        const verifyUrl = await admin.auth().generateEmailVerificationLink(to, {
            url: `${getAppUrl()}/login?verified=true`,
            handleCodeInApp: false,
        });
        jobs.push({
            campaign: 'verifyReminder',
            payload: { ...base, verify_url: verifyUrl },
        });
    }

    console.log(`From: ${getEmailFrom()}`);
    console.log(`To:   ${to}`);
    console.log(`Uid:  ${authUser.uid}`);
    console.log(`Mode: ${mode}`);
    console.log('');

    for (const job of jobs) {
        const spec = CAMPAIGN_SPECS[job.campaign];
        const rendered = renderCampaignHtml(job.campaign, job.payload);
        try {
            const result = await sendWithResend({
                to,
                subject: `[TEST] ${rendered.subject}`,
                html: rendered.html,
                unsubscribeUrl: spec.marketing && spec.listUnsubscribe !== false ? unsubscribeUrl : undefined,
                tags: [
                    { name: 'campaign', value: job.campaign },
                    { name: 'uid', value: authUser.uid },
                    { name: 'test', value: 'true' },
                ],
            });
            console.log(`OK  ${job.campaign}  marketing=${spec.marketing}  id=${result.id || '(none)'}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`FAIL ${job.campaign}  ${message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2500));
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
