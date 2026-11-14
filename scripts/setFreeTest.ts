/**
 * Set santhoshkannan525 (or 317) to free on Stripe TEST + Firestore.
 * Usage: npx ts-node --transpile-only scripts/setFreeTest.ts --apply
 */
import '../env';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

const EMAILS = ['santhoshkannan525@gmail.com', 'santhoshkannan317@gmail.com'];
const APPLY = process.argv.includes('--apply');

function initAdmin() {
    if (admin.apps.length) return;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
    });
}

async function findUser() {
    for (const email of EMAILS) {
        try {
            const user = await admin.auth().getUserByEmail(email);
            return { uid: user.uid, email: user.email ?? email };
        } catch {
            // keep looking
        }
    }
    throw new Error(`No Firebase user found for ${EMAILS.join(', ')}`);
}

async function main() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key?.startsWith('sk_test_')) {
        throw new Error('Refusing: STRIPE_SECRET_KEY must be sk_test_…');
    }

    initAdmin();
    const { uid, email } = await findUser();
    const ref = admin.firestore().doc(`users/${uid}`);
    const snap = await ref.get();
    const data = snap.data() || {};
    const sub = data.subscription || {};

    console.log(
        JSON.stringify(
            {
                email,
                uid,
                before: {
                    plan: sub.plan ?? null,
                    status: sub.status ?? null,
                    stripeSub: sub.stripeSubscriptionId ?? null,
                    stripeCustomer: sub.stripeCustomerId ?? null,
                },
            },
            null,
            2
        )
    );

    if (!APPLY) {
        console.log('Dry run. Re-run with --apply to set free.');
        return;
    }

    const stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
    const customerId: string | undefined = sub.stripeCustomerId || undefined;
    const keepStatuses = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

    if (customerId) {
        try {
            await stripe.customers.retrieve(customerId);
            const existingSubs = await stripe.subscriptions.list({
                customer: customerId,
                status: 'all',
                limit: 20,
            });
            for (const existing of existingSubs.data) {
                if (keepStatuses.has(existing.status) || existing.status === 'incomplete') {
                    const invoices = await stripe.invoices.list({
                        subscription: existing.id,
                        status: 'open',
                        limit: 10,
                    });
                    for (const invoice of invoices.data) {
                        if (invoice.status === 'open') {
                            await stripe.invoices.voidInvoice(invoice.id);
                        }
                    }
                    if (existing.status !== 'canceled') {
                        await stripe.subscriptions.cancel(existing.id, {
                            invoice_now: false,
                            prorate: false,
                        });
                        console.log(`canceled ${existing.id} (${existing.status})`);
                    }
                }
            }
        } catch (err) {
            console.warn('Stripe cleanup skipped (live/missing customer?):', (err as Error).message);
        }
    }

    const previousPlan =
        sub.plan === 'part_time' || sub.plan === 'jobs_premium' || sub.plan === 'premium'
            ? sub.plan
            : sub.lastPaidPlan ?? null;

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
        },
        { merge: true }
    );

    console.log(JSON.stringify({ granted: 'free', email, uid, lastPaidPlan: previousPlan }, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
