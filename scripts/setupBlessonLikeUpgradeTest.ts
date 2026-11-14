/**
 * Put a test account in a Blesson-like state:
 * - active Jobs Premium Weekly
 * - optional phantom Stripe customer debit (default £43.92 like blesson)
 *
 * Then log in and open Upgrade + CAFY15. With the payment fix deployed you should
 * see / pay promo − weekly credit only — NOT promo + £43.92.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/setupBlessonLikeUpgradeTest.ts
 *   npx ts-node --transpile-only scripts/setupBlessonLikeUpgradeTest.ts --apply
 *   npx ts-node --transpile-only scripts/setupBlessonLikeUpgradeTest.ts --apply --email=you@example.com
 *   npx ts-node --transpile-only scripts/setupBlessonLikeUpgradeTest.ts --apply --no-phantom-debit
 */
import '../env';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

const DEFAULT_EMAILS = ['santhoshkannan525@gmail.com', 'santhoshkannan317@gmail.com'];
const APPLY = process.argv.includes('--apply');
const NO_PHANTOM = process.argv.includes('--no-phantom-debit');
/** Blesson's applied balance was 4392 pence. */
const PHANTOM_DEBIT_PENCE = 4392;

function argValue(prefix: string): string | null {
    const hit = process.argv.find((a) => a.startsWith(prefix));
    if (!hit) return null;
    const v = hit.slice(prefix.length);
    return v.trim() || null;
}

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

async function findUser(emails: string[]) {
    for (const email of emails) {
        try {
            const user = await admin.auth().getUserByEmail(email);
            return { uid: user.uid, email: user.email ?? email };
        } catch {
            // keep looking
        }
    }
    throw new Error(`No Firebase user found for ${emails.join(', ')}`);
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
    if (!key?.startsWith('sk_live_')) {
        throw new Error('This script is for live Stripe (sk_live_…). Refusing.');
    }

    const emailArg = argValue('--email=');
    const emails = emailArg ? [emailArg] : DEFAULT_EMAILS;

    console.log(
        JSON.stringify(
            {
                apply: APPLY,
                phantomDebitPence: NO_PHANTOM ? 0 : PHANTOM_DEBIT_PENCE,
                emails,
            },
            null,
            2
        )
    );

    initAdmin();
    const { uid, email } = await findUser(emails);
    const snap = await admin.firestore().doc(`users/${uid}`).get();
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
                    interval: sub.billingInterval ?? null,
                    priceId: briefId(sub.priceId),
                    stripeSub: briefId(sub.stripeSubscriptionId),
                    stripeCustomer: briefId(sub.stripeCustomerId),
                },
            },
            null,
            2
        )
    );

    if (!APPLY) {
        console.log('Dry run. Re-run with --apply to grant Jobs Weekly (+ phantom debit).');
        return;
    }

    const stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
    let customerId: string | undefined = sub.stripeCustomerId || undefined;

    if (customerId) {
        try {
            const existingCustomer = await stripe.customers.retrieve(customerId);
            if (existingCustomer.deleted) {
                console.log(`stored customer ${briefId(customerId)} is deleted; will recreate`);
                customerId = undefined;
            }
        } catch (err: any) {
            console.log(
                `stored customer ${briefId(customerId)} missing (${err?.code || err?.message || 'error'}); will recreate`
            );
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
    } else {
        console.log(`using stripe customer ${briefId(customerId)}`);
    }

    // Reset customer balance to 0 first (clear credit or debit).
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted) {
        const bal = customer.balance ?? 0;
        if (bal !== 0) {
            await stripe.customers.createBalanceTransaction(customerId, {
                amount: -bal,
                currency: 'gbp',
                description: 'Reset balance before Blesson-like upgrade test',
            });
            console.log(`reset customer balance from ${bal} → 0`);
        }
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
                console.log(
                    `canceled ${briefId(existing.id)} status=${existing.status} price=${briefId(priceId)}`
                );
            }
        }
    }

    if (!weeklySub) {
        weeklySub = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: weeklyPriceId }],
            collection_method: 'send_invoice',
            days_until_due: 7,
            metadata: { firebaseUid: uid, grantedBy: 'setupBlessonLikeUpgradeTest' },
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

    if (!NO_PHANTOM) {
        await stripe.customers.createBalanceTransaction(customerId, {
            amount: PHANTOM_DEBIT_PENCE,
            currency: 'gbp',
            description: 'Test phantom debit (Blesson-like failed-upgrade residue)',
        });
        console.log(`seeded phantom debit £${(PHANTOM_DEBIT_PENCE / 100).toFixed(2)}`);
    }

    const completedAt = new Date().toISOString();
    await admin.firestore().doc(`users/${uid}`).set(
        {
            subscription: {
                provider: 'stripe',
                plan: 'jobs_premium',
                status:
                    weeklySub.status === 'active' || weeklySub.status === 'trialing'
                        ? 'active'
                        : weeklySub.status,
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

    const refreshed = await stripe.customers.retrieve(customerId);
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 5 });
    const balance = !refreshed.deleted ? refreshed.balance : null;

    console.log(
        JSON.stringify(
            {
                applied: true,
                email,
                uid,
                customerId,
                subscriptionId: weeklySub.id,
                customerBalancePence: balance,
                customerBalanceGBP: balance != null ? (balance / 100).toFixed(2) : null,
                hasSavedCard: pms.data.length > 0,
                cards: pms.data.map((pm) => ({
                    brand: pm.card?.brand,
                    last4: pm.card?.last4,
                })),
                howToTest: [
                    '1. Deploy ProductBackend with the payment fix (if not already on prod).',
                    `2. Log in as ${email}`,
                    '3. Open Subscription → upgrade to Full Premium Monthly',
                    '4. Apply CAFY15',
                    '5. Preview should be ~£15 minus unused weekly credit (NOT £15+£43.92)',
                    '6. Confirm pay — with the fix, phantom £43.92 is wiped before charge',
                ],
                expectedWithFix:
                    'Charge ≈ CAFY15 net (£14.99) − unused weekly credit. Must NOT include £43.92.',
                expectedWithoutFixDeployed:
                    'Would charge ~£14.99 + £43.92 ≈ £58.91 (Blesson bug).',
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
