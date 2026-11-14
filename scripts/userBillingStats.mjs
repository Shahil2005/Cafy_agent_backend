import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import Stripe from 'stripe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envText = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const key = process.env.STRIPE_SECRET_KEY || '';
const mode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown';
if (!key) throw new Error('STRIPE_SECRET_KEY missing');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const stripe = new Stripe(key);
const db = admin.firestore();

function monthlyPenceFromItem(item, discount) {
  const price = item?.price;
  const amount = typeof price?.unit_amount === 'number' ? price.unit_amount : 0;
  const rec = price?.recurring;
  if (!rec || amount <= 0) return { gross: 0, net: 0 };
  const count = rec.interval_count || 1;
  let monthly = amount;
  if (rec.interval === 'week') monthly = (amount * 52) / 12 / count;
  else if (rec.interval === 'month') monthly = amount / count;
  else if (rec.interval === 'year') monthly = amount / 12 / count;
  let net = monthly;
  if (discount?.coupon) {
    const c = discount.coupon;
    if (typeof c.percent_off === 'number') net = monthly * (1 - c.percent_off / 100);
    else if (typeof c.amount_off === 'number') {
      let offMonthly = c.amount_off;
      if (c.duration !== 'forever' && rec.interval === 'week') offMonthly = (c.amount_off * 52) / 12 / count;
      else if (rec.interval === 'month') offMonthly = c.amount_off / count;
      else if (rec.interval === 'year') offMonthly = c.amount_off / 12 / count;
      net = Math.max(0, monthly - offMonthly);
    }
  }
  return { gross: monthly, net };
}

async function countAuthUsers() {
  let count = 0;
  let pageToken;
  do {
    const res = await admin.auth().listUsers(1000, pageToken);
    count += res.users.length;
    pageToken = res.pageToken;
  } while (pageToken);
  return count;
}

async function countFirestoreUsersAndDocs() {
  let firestoreUsers = 0;
  let withResumeField = 0;
  let withResumeSubcollection = 0;
  const resumeUserIds = new Set();

  let last = null;
  for (;;) {
    let q = db.collection('users').orderBy(admin.firestore.FieldPath.documentId()).limit(400);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    firestoreUsers += snap.size;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const resume = data.resume;
      if (resume && (resume.content || resume.name || resume.uploadedAt)) withResumeField += 1;
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }

  try {
    let rLast = null;
    for (;;) {
      let q = db.collectionGroup('resumes').limit(400);
      if (rLast) q = q.startAfter(rLast);
      const snap = await q.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        const uid = doc.ref.parent.parent?.id;
        if (uid) resumeUserIds.add(uid);
      }
      rLast = snap.docs[snap.docs.length - 1];
      if (snap.size < 400) break;
    }
    withResumeSubcollection = resumeUserIds.size;
  } catch (err) {
    console.error('resumes collectionGroup failed:', err?.message || err);
  }

  return { firestoreUsers, withResumeField, withResumeSubcollection };
}

async function stripeStats() {
  const byStatus = {};
  const paidCustomers = new Set();
  const scheduledCancelCustomers = new Set();
  const canceledCustomers = new Set();
  const pastDueCustomers = new Set();
  const planCounts = { weekly: 0, jobs_monthly: 0, monthly: 0, quarterly: 0, other: 0 };
  let activeSubs = 0;
  let scheduledCancelSubs = 0;
  let canceledSubs = 0;
  let pastDueSubs = 0;
  let grossMrrPence = 0;
  let netMrrPence = 0;

  const weeklyId = process.env.STRIPE_PRICE_WEEKLY;
  const jobsMonthlyId = process.env.STRIPE_PRICE_JOBS_MONTHLY;
  const monthlyId = process.env.STRIPE_PRICE_MONTHLY;
  const quarterlyId = process.env.STRIPE_PRICE_QUARTERLY;

  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    byStatus[sub.status] = (byStatus[sub.status] || 0) + 1;
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    const priceId = sub.items?.data?.[0]?.price?.id;
    const rec = sub.items?.data?.[0]?.price?.recurring;
    const scheduled = sub.cancel_at_period_end === true || (typeof sub.cancel_at === 'number' && sub.cancel_at > Math.floor(Date.now() / 1000));
    const discount = sub.discount || sub.discounts?.[0] || null;

    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      canceledSubs += 1;
      if (customerId) canceledCustomers.add(customerId);
      continue;
    }

    if (sub.status === 'past_due' || sub.status === 'unpaid') {
      pastDueSubs += 1;
      if (customerId) pastDueCustomers.add(customerId);
    }

    if (sub.status === 'active' || sub.status === 'trialing') {
      activeSubs += 1;
      if (customerId) paidCustomers.add(customerId);
      if (scheduled) {
        scheduledCancelSubs += 1;
        if (customerId) scheduledCancelCustomers.add(customerId);
      }
      const { gross, net } = monthlyPenceFromItem(sub.items?.data?.[0], discount);
      grossMrrPence += gross;
      netMrrPence += net;

      if (priceId === weeklyId || rec?.interval === 'week') planCounts.weekly += 1;
      else if (priceId === jobsMonthlyId) planCounts.jobs_monthly += 1;
      else if (priceId === quarterlyId || (rec?.interval === 'month' && rec?.interval_count === 3)) planCounts.quarterly += 1;
      else if (priceId === monthlyId || rec?.interval === 'month') planCounts.monthly += 1;
      else planCounts.other += 1;
    }
  }

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartUnix = Math.floor(monthStart.getTime() / 1000);
  let collectedThisMonthPence = 0;
  let paidInvoicesThisMonth = 0;
  for await (const inv of stripe.invoices.list({
    status: 'paid',
    created: { gte: monthStartUnix },
    limit: 100,
  })) {
    if (typeof inv.amount_paid === 'number') {
      collectedThisMonthPence += inv.amount_paid;
      paidInvoicesThisMonth += 1;
    }
  }

  return {
    byStatus,
    uniquePaidCustomers: paidCustomers.size,
    uniqueScheduledCancel: scheduledCancelCustomers.size,
    uniqueCanceledCustomers: canceledCustomers.size,
    uniquePastDue: pastDueCustomers.size,
    activeSubs,
    scheduledCancelSubs,
    canceledSubs,
    pastDueSubs,
    planCounts,
    grossMrrGbp: +(grossMrrPence / 100).toFixed(2),
    netMrrGbp: +(netMrrPence / 100).toFixed(2),
    collectedThisMonthGbp: +(collectedThisMonthPence / 100).toFixed(2),
    paidInvoicesThisMonth,
    monthStartUtc: monthStart.toISOString(),
  };
}

async function main() {
  console.log(JSON.stringify({ stripe_mode: mode }, null, 2));
  const [authUsers, docs, billing] = await Promise.all([
    countAuthUsers(),
    countFirestoreUsersAndDocs(),
    stripeStats(),
  ]);
  const withDocs = new Set();
  // withDocs unique is resume field OR subcollection — we only have counts, so report both + union estimate
  console.log(
    JSON.stringify(
      {
        users: {
          authUsers,
          firestoreUserDocs: docs.firestoreUsers,
          usersWithResumeOnProfile: docs.withResumeField,
          usersWithUploadedResumeDocs: docs.withResumeSubcollection,
        },
        billing,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
