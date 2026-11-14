/**
 * Monthly Stripe money: list vs collected, coupon discounts, fees, net remaining.
 *
 *   npx ts-node --transpile-only scripts/monthlyNetRevenue.ts
 */
import '../env';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-04-22.dahlia',
});

function gbp(pence: number) {
  return Number((pence / 100).toFixed(2));
}

function monthKey(unix: number) {
  const d = new Date(unix * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

type StripePage<T extends { id: string }> = {
  data: T[];
  has_more: boolean;
};

async function paginate<T extends { id: string }>(
  fetchPage: (startingAfter?: string) => Promise<StripePage<T>>
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await fetchPage(startingAfter);
    all.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
  return all;
}

type MonthAgg = {
  month: string;
  charges: number;
  grossCollectedPence: number; // what customers actually paid (post-coupon)
  refundsPence: number;
  stripeFeesPence: number;
  netPence: number; // remaining after refunds + Stripe fees
  invoiceCount: number;
  listSubtotalPence: number; // pre-discount invoice subtotals (paid invoices)
  couponDiscountPence: number;
  invoiceAmountPaidPence: number;
};

async function main() {
  // From 2025-01-01 UTC through now (covers live product history)
  const createdGte = Math.floor(Date.UTC(2025, 0, 1) / 1000);
  const now = Math.floor(Date.now() / 1000);

  console.error('Fetching succeeded charges…');
  const charges = await paginate((startingAfter) =>
    stripe.charges.list({
      limit: 100,
      created: { gte: createdGte, lte: now },
      starting_after: startingAfter,
      expand: ['data.balance_transaction'],
    })
  );

  const byMonth = new Map<string, MonthAgg>();
  const ensure = (m: string): MonthAgg => {
    let row = byMonth.get(m);
    if (!row) {
      row = {
        month: m,
        charges: 0,
        grossCollectedPence: 0,
        refundsPence: 0,
        stripeFeesPence: 0,
        netPence: 0,
        invoiceCount: 0,
        listSubtotalPence: 0,
        couponDiscountPence: 0,
        invoiceAmountPaidPence: 0,
      };
      byMonth.set(m, row);
    }
    return row;
  };

  for (const ch of charges) {
    if (ch.status !== 'succeeded' || ch.currency !== 'gbp') continue;
    const m = monthKey(ch.created);
    const row = ensure(m);
    row.charges += 1;
    row.grossCollectedPence += ch.amount;
    row.refundsPence += ch.amount_refunded || 0;

    const bt = ch.balance_transaction;
    if (bt && typeof bt === 'object') {
      // Stripe fee on this charge (positive). Net already subtracts fee + refunds timing
      // can lag; we use fee from BT and compute net as collected - refunds - fees.
      row.stripeFeesPence += bt.fee || 0;
    }
  }

  console.error('Fetching paid invoices (for coupon / list-price discount)…');
  const invoices = await paginate((startingAfter) =>
    stripe.invoices.list({
      limit: 100,
      created: { gte: createdGte, lte: now },
      status: 'paid',
      starting_after: startingAfter,
    })
  );

  for (const inv of invoices) {
    if (inv.currency !== 'gbp') continue;
    const m = monthKey(inv.created);
    const row = ensure(m);
    row.invoiceCount += 1;
    row.listSubtotalPence += inv.subtotal || 0;
    const discount =
      (inv.total_discount_amounts || []).reduce((s, d) => s + (d.amount || 0), 0) ||
      Math.max(0, (inv.subtotal || 0) - (inv.total || 0));
    row.couponDiscountPence += discount;
    row.invoiceAmountPaidPence += inv.amount_paid || 0;
  }

  for (const row of byMonth.values()) {
    row.netPence = row.grossCollectedPence - row.refundsPence - row.stripeFeesPence;
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  const out = {
    asOf: new Date().toISOString(),
    note:
      'grossCollected = what cards were charged (already after coupons). ' +
      'couponDiscount = invoice list/subtotal reductions. ' +
      'net = grossCollected - refunds - Stripe fees (real remaining).',
    months: months.map((r) => ({
      month: r.month,
      charges: r.charges,
      listSubtotal: gbp(r.listSubtotalPence),
      couponDiscount: gbp(r.couponDiscountPence),
      grossCollected: gbp(r.grossCollectedPence),
      refunds: gbp(r.refundsPence),
      stripeFees: gbp(r.stripeFeesPence),
      netRemaining: gbp(r.netPence),
      invoices: r.invoiceCount,
    })),
    totals: (() => {
      const t = months.reduce(
        (a, r) => ({
          charges: a.charges + r.charges,
          listSubtotal: a.listSubtotal + r.listSubtotalPence,
          couponDiscount: a.couponDiscount + r.couponDiscountPence,
          grossCollected: a.grossCollected + r.grossCollectedPence,
          refunds: a.refunds + r.refundsPence,
          stripeFees: a.stripeFees + r.stripeFeesPence,
          netRemaining: a.netRemaining + r.netPence,
        }),
        {
          charges: 0,
          listSubtotal: 0,
          couponDiscount: 0,
          grossCollected: 0,
          refunds: 0,
          stripeFees: 0,
          netRemaining: 0,
        }
      );
      return {
        charges: t.charges,
        listSubtotal: gbp(t.listSubtotal),
        couponDiscount: gbp(t.couponDiscount),
        grossCollected: gbp(t.grossCollected),
        refunds: gbp(t.refunds),
        stripeFees: gbp(t.stripeFees),
        netRemaining: gbp(t.netRemaining),
      };
    })(),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
