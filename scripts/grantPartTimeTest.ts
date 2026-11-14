/**
 * Grant Part-time Weekly on Stripe TEST + Firestore for local QA.
 * Usage:
 *   npx ts-node scripts/grantPartTimeTest.ts
 *   npx ts-node scripts/grantPartTimeTest.ts --apply
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
    const partTimePriceId = process.env.STRIPE_PRICE_PART_TIME_WEEKLY?.trim();
    if (!partTimePriceId) throw new Error('STRIPE_PRICE_PART_TIME_WEEKLY missing');
    if (!key?.startsWith('sk_test_')) {
        throw new Error('Refusing: STRIPE_SECRET_KEY must be a test key (sk_test_…)');
    }

    console.log(`stripe_mode=test apply=${APPLY} price=${partTimePriceId}`);
    initAdmin();

    const { uid, email } = await findUser();
    const snap = await admin.firestore().doc(`users/${uid}`).get();
    const data = snap.data() || {};
    const sub = data.subscription || {};
    const planSelection = data.planSelection || {};
    const locations = data.preferences?.locations ?? null;

    console.log(
        JSON.stringify(
            {
                email,
                uid,
                locations,
                firestore: {
                    plan: sub.plan ?? null,
                    status: sub.status ?? null,
                    interval: sub.billingInterval ?? null,
                    priceId: briefId(sub.priceId),
                    stripeSub: briefId(sub.stripeSubscriptionId),
                    stripeCustomer: briefId(sub.stripeCustomerId),
                    periodEnd: sub.currentPeriodEnd?.toDate?.()?.toISOString?.() ?? null,
                    chosenPlan: planSelection.chosenPlan ?? null,
                },
            },
            null,
            2
        )
    );

    if (!APPLY) {
        console.log('Dry run. Re-run with --apply to grant Part-time Weekly (test).');
        return;
    }

    const price = await new Stripe(key, { apiVersion: '2026-04-22.dahlia' }).prices.retrieve(
        partTimePriceId
    );
    if (!price.active || price.currency !== 'gbp') {
        throw new Error(`Part-time price must be active GBP (got ${price.currency} active=${price.active})`);
    }

    const stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
    let customerId: string | undefined = sub.stripeCustomerId || undefined;

    // Live-mode customer IDs in Firestore won't resolve under sk_test_ — recreate in test.
    if (customerId) {
        try {
            await stripe.customers.retrieve(customerId);
        } catch {
            console.log(`ignoring live/missing customer ${briefId(customerId)}; creating test customer`);
            customerId = undefined;
        }
    }

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
    let partTimeSub: any = null;

    for (const existing of existingSubs.data) {
        const priceId = existing.items.data[0]?.price?.id;
        if (keepStatuses.has(existing.status) && priceId === partTimePriceId) {
            partTimeSub = existing;
            continue;
        }
        if (keepStatuses.has(existing.status) || existing.status === 'incomplete') {
            await voidOpenInvoices(stripe, existing.id);
            if (existing.status !== 'canceled') {
                await stripe.subscriptions.cancel(existing.id, {
                    invoice_now: false,
                    prorate: false,
                });
                console.log(
                    `canceled ${briefId(existing.id)} status=${existing.status} price=${briefId(priceId)}`
                );
            }
        }
    }

    if (!partTimeSub) {
        partTimeSub = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: partTimePriceId }],
            collection_method: 'send_invoice',
            days_until_due: 7,
            metadata: { firebaseUid: uid, grantedBy: 'grantPartTimeTest' },
        });
        console.log(`created part-time sub ${briefId(partTimeSub.id)} status=${partTimeSub.status}`);
    }

    const latestInvoiceId =
        typeof partTimeSub.latest_invoice === 'string'
            ? partTimeSub.latest_invoice
            : partTimeSub.latest_invoice?.id;

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

    partTimeSub = await stripe.subscriptions.retrieve(partTimeSub.id);
    const item = partTimeSub.items.data[0];
    const periodStart = item?.current_period_start ?? partTimeSub.start_date;
    const periodEnd = item?.current_period_end;
    if (!periodEnd) throw new Error('Part-time subscription missing period end');

    const completedAt = new Date().toISOString();
    const status =
        partTimeSub.status === 'active' || partTimeSub.status === 'trialing'
            ? 'active'
            : partTimeSub.status;

    await admin.firestore().doc(`users/${uid}`).set(
        {
            subscription: {
                provider: 'stripe',
                plan: 'part_time',
                status,
                stripeCustomerId: customerId,
                stripeSubscriptionId: partTimeSub.id,
                priceId: partTimePriceId,
                billingInterval: 'weekly',
                currentPeriodStart: admin.firestore.Timestamp.fromMillis(periodStart * 1000),
                currentPeriodEnd: admin.firestore.Timestamp.fromMillis(periodEnd * 1000),
                cancelAtPeriodEnd: partTimeSub.cancel_at_period_end === true,
                stripePromotionCode: null,
            },
            planSelection: {
                completed: true,
                chosenPlan: 'part_time_weekly',
                completedAt,
            },
            // Part-time catalog is UK-only — ensure profile can access it.
            preferences: {
                ...(data.preferences || {}),
                locations: ['United Kingdom'],
            },
        },
        { merge: true }
    );

    console.log(
        JSON.stringify(
            {
                granted: true,
                email,
                uid,
                plan: 'part_time',
                status,
                priceId: partTimePriceId,
                stripeSub: partTimeSub.id,
                periodEnd: new Date(periodEnd * 1000).toISOString(),
                locations: ['United Kingdom'],
            },
            null,
            2
        )
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
