/**
 * One-off: inspect / grant Jobs Premium Weekly on live Stripe + Firestore.
 * Usage:
 *   npx ts-node scripts/setJobsWeeklyLive.ts
 *   npx ts-node scripts/setJobsWeeklyLive.ts --apply
 *   npx ts-node scripts/setJobsWeeklyLive.ts --apply --email=you@example.com
 */
import '../env';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

const EMAIL_ARG = process.argv.find((a) => a.startsWith('--email='))?.slice('--email='.length).trim();
const EMAILS = EMAIL_ARG ? [EMAIL_ARG] : ['santhoshkannan525@gmail.com', 'santhoshkannan317@gmail.com'];
const APPLY = process.argv.includes('--apply');

function initAdmin() {
    if (admin.apps.length) return;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
    });
}

function stripeMode(key: string | undefined) {
    if (!key) return 'missing';
    if (key.startsWith('sk_live_')) return 'live';
    if (key.startsWith('sk_test_')) return 'test';
    return 'unknown';
}

function briefId(id: string | null | undefined) {
    if (!id) return null;
    return id.length > 14 ? `${id.slice(0, 10)}…` : id;
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

async function voidOpenInvoices(stripe: InstanceType<typeof Stripe>, subscriptionId: string) {
    const invoices = await stripe.invoices.list({
        subscription: subscriptionId,
        status: 'open',
        limit: 20,
    });
    for (const invoice of invoices.data) {
        if (invoice.status === 'open') {
            await stripe.invoices.voidInvoice(invoice.id);
            console.log(`voided open invoice ${briefId(invoice.id)}`);
        }
    }
}

async function main() {
    const key = process.env.STRIPE_SECRET_KEY;
    const weeklyPriceId = process.env.STRIPE_PRICE_WEEKLY;
    if (!weeklyPriceId) throw new Error('STRIPE_PRICE_WEEKLY missing');

    console.log(`stripe_mode=${stripeMode(key)} apply=${APPLY}`);
    initAdmin();

    const { uid, email } = await findUser();
    const snap = await admin.firestore().doc(`users/${uid}`).get();
    const data = snap.data() || {};
    const sub = data.subscription || {};
    const planSelection = data.planSelection || {};

    console.log(
        JSON.stringify(
            {
                email,
                uid,
                firestore: {
                    plan: sub.plan ?? null,
                    status: sub.status ?? null,
                    interval: sub.billingInterval ?? null,
                    priceId: briefId(sub.priceId),
                    stripeSub: briefId(sub.stripeSubscriptionId),
                    stripeCustomer: briefId(sub.stripeCustomerId),
                    periodEnd: sub.currentPeriodEnd?.toDate?.()?.toISOString?.() ?? null,
                    chosenPlan: planSelection.chosenPlan ?? null,
                    planSelectionCompleted: planSelection.completed === true,
                },
            },
            null,
            2
        )
    );

    if (!APPLY) {
        console.log('Dry run. Re-run with --apply to clear and grant Jobs Weekly.');
        return;
    }

    if (!key?.startsWith('sk_live_')) {
        throw new Error('Refusing to apply: STRIPE_SECRET_KEY is not live');
    }

    const stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
    let customerId: string | undefined = sub.stripeCustomerId || undefined;

    if (!customerId) {
        const existing = await stripe.customers.list({ email, limit: 5 });
        customerId = existing.data[0]?.id;
    }
    if (!customerId) {
        const created = await stripe.customers.create({
            email,
            metadata: { firebaseUid: uid },
        });
        customerId = created.id;
        console.log(`created stripe customer ${briefId(customerId)}`);
    }

    const existingSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 20,
    });

    const keepStatuses = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
    let weeklySub: any = null;

    for (const existing of existingSubs.data) {
        const priceId = existing.items.data[0]?.price?.id;
        if (keepStatuses.has(existing.status) && priceId === weeklyPriceId) {
            weeklySub = existing;
            continue;
        }
        if (keepStatuses.has(existing.status) || existing.status === 'incomplete') {
            await voidOpenInvoices(stripe, existing.id);
            if (existing.status !== 'canceled') {
                await stripe.subscriptions.cancel(existing.id, { invoice_now: false, prorate: false });
                console.log(`canceled ${briefId(existing.id)} status=${existing.status} price=${briefId(priceId)}`);
            }
        }
    }

    if (!weeklySub) {
        weeklySub = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: weeklyPriceId }],
            collection_method: 'send_invoice',
            days_until_due: 7,
            metadata: { firebaseUid: uid, grantedBy: 'setJobsWeeklyLive' },
        });
        console.log(`created weekly sub ${briefId(weeklySub.id)} status=${weeklySub.status}`);
    }

    const latestInvoiceId =
        typeof weeklySub.latest_invoice === 'string'
            ? weeklySub.latest_invoice
            : weeklySub.latest_invoice?.id;

    if (latestInvoiceId) {
        const invoice = await stripe.invoices.retrieve(latestInvoiceId);
        if (invoice.status === 'open' || invoice.status === 'draft') {
            if (invoice.status === 'draft') {
                await stripe.invoices.finalizeInvoice(invoice.id);
            }
            await stripe.invoices.pay(invoice.id, { paid_out_of_band: true });
            console.log(`marked invoice ${briefId(invoice.id)} paid_out_of_band`);
        }
    }

    weeklySub = await stripe.subscriptions.retrieve(weeklySub.id);
    const item = weeklySub.items.data[0];
    const periodStart = item?.current_period_start ?? weeklySub.start_date;
    const periodEnd = item?.current_period_end;
    if (!periodEnd) throw new Error('Weekly subscription missing period end');

    const completedAt = new Date().toISOString();
    await admin.firestore().doc(`users/${uid}`).set(
        {
            subscription: {
                provider: 'stripe',
                plan: 'jobs_premium',
                status: weeklySub.status === 'active' || weeklySub.status === 'trialing' ? 'active' : weeklySub.status,
                stripeCustomerId: customerId,
                stripeSubscriptionId: weeklySub.id,
                priceId: weeklyPriceId,
                billingInterval: 'weekly',
                currentPeriodStart: admin.firestore.Timestamp.fromMillis(periodStart * 1000),
                currentPeriodEnd: admin.firestore.Timestamp.fromMillis(periodEnd * 1000),
                cancelAtPeriodEnd: weeklySub.cancel_at_period_end === true,
                stripePromotionCode: null,
            },
            planSelection: {
                completed: true,
                chosenPlan: 'weekly',
                completedAt,
            },
            requiresPlanSelection: false,
            chosenPlan: 'weekly',
            isPremium: false,
        },
        { merge: true }
    );

    const after = (await admin.firestore().doc(`users/${uid}`).get()).data()?.subscription || {};
    console.log(
        JSON.stringify(
            {
                applied: true,
                firestore: {
                    plan: after.plan,
                    status: after.status,
                    interval: after.billingInterval,
                    priceId: briefId(after.priceId),
                    stripeSub: briefId(after.stripeSubscriptionId),
                    periodEnd: after.currentPeriodEnd?.toDate?.()?.toISOString?.() ?? null,
                },
                stripe: {
                    status: weeklySub.status,
                    priceId: briefId(item?.price?.id),
                },
            },
            null,
            2
        )
    );
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
