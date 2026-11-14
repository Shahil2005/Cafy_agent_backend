/**
 * Immediately cancel Stripe paid subs + set Firestore free for specific emails.
 * Leaves pranavkaarthikponnusamy@gmail.com untouched.
 *
 *   npx ts-node --transpile-only scripts/setRefundedUsersFreeLive.ts --apply
 */
import '../env';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

const EMAILS = [
    'leenuspaulsolomon@gmail.com',
    'raphaelinnocent.archbim@gmail.com',
    'rajesh101321@gmail.com',
];
const APPLY = process.argv.includes('--apply');

function initAdmin() {
    if (admin.apps.length) return;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
    });
}

async function voidOpenInvoices(stripe: InstanceType<typeof Stripe>, subscriptionId: string) {
    const invoices = await stripe.invoices.list({
        subscription: subscriptionId,
        status: 'open',
        limit: 20,
    });
    for (const inv of invoices.data) {
        try {
            await stripe.invoices.voidInvoice(inv.id);
            console.log('  voided', inv.id);
        } catch (err) {
            console.warn('  void failed', inv.id, (err as Error).message);
        }
    }
}

async function main() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key?.startsWith('sk_live_')) {
        throw new Error('Refusing: STRIPE_SECRET_KEY must be sk_live_…');
    }

    initAdmin();
    const stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
    const keep = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

    console.log(JSON.stringify({ apply: APPLY, emails: EMAILS }, null, 2));

    for (const email of EMAILS) {
        console.log('\n===', email, '===');
        let user: admin.auth.UserRecord;
        try {
            user = await admin.auth().getUserByEmail(email);
        } catch {
            console.error('Firebase user not found');
            continue;
        }

        const uid = user.uid;
        const ref = admin.firestore().doc(`users/${uid}`);
        const snap = await ref.get();
        const data = snap.data() || {};
        const sub = (data.subscription || {}) as Record<string, unknown>;
        let customerId = (sub.stripeCustomerId as string | undefined) || undefined;

        if (!customerId) {
            const listed = await stripe.customers.list({ email, limit: 5 });
            customerId = listed.data[0]?.id;
        }

        console.log({
            uid,
            customerId,
            planBefore: sub.plan ?? null,
            statusBefore: sub.status ?? null,
        });

        if (!APPLY) {
            console.log('Dry run — skip cancel/write');
            continue;
        }

        if (customerId) {
            const subs = await stripe.subscriptions.list({
                customer: customerId,
                status: 'all',
                limit: 20,
            });
            for (const s of subs.data) {
                if (keep.has(s.status) || s.status === 'incomplete') {
                    await voidOpenInvoices(stripe, s.id);
                    if (s.status !== 'canceled') {
                        await stripe.subscriptions.cancel(s.id, {
                            invoice_now: false,
                            prorate: false,
                        });
                        console.log('  canceled', s.id, s.status);
                    }
                }
            }
        }

        const previousPlan =
            sub.plan === 'part_time' || sub.plan === 'jobs_premium' || sub.plan === 'premium'
                ? sub.plan
                : (sub.lastPaidPlan as string | null) ?? null;

        await ref.set(
            {
                subscription: {
                    provider: 'none',
                    plan: 'free',
                    status: 'canceled',
                    stripeCustomerId: customerId ?? null,
                    stripeSubscriptionId: null,
                    priceId: null,
                    billingInterval: null,
                    currentPeriodStart: null,
                    currentPeriodEnd: null,
                    cancelAtPeriodEnd: false,
                    stripePromotionCode: null,
                    lastPaidPlan: previousPlan,
                },
                planSelection: {
                    completed: true,
                    chosenPlan: 'free',
                    completedAt: new Date().toISOString(),
                },
                requiresPlanSelection: false,
                chosenPlan: 'free',
                isPremium: false,
            },
            { merge: true }
        );

        console.log('  firestore -> free', { lastPaidPlan: previousPlan });
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
