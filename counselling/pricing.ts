import { getStripe, isStripeConfigured } from '../billing/stripeClient';
import type { DurationMinutes } from './types';

type PriceTier = 'standard' | 'premium';

type PriceEntry = { pence: number; label: string };

/** Fallback only when Stripe price IDs are missing or Stripe is unreachable. */
const FALLBACK_STANDARD_PENCE: Record<DurationMinutes, number> = {
    30: 3000,
    45: 3500,
    60: 4000,
};

const FALLBACK_PREMIUM_PENCE: Record<DurationMinutes, number> = {
    30: 2500,
    45: 3000,
    60: 3500,
};

const CACHE_MS = 5 * 60 * 1000;

let cachedTable: {
    expires: number;
    standard: Record<DurationMinutes, PriceEntry>;
    premium: Record<DurationMinutes, PriceEntry>;
} | null = null;

function counsellingStripePriceEnvKey(durationMinutes: DurationMinutes, tier: PriceTier): string {
    return `STRIPE_PRICE_COUNSELLING_${durationMinutes}_${tier.toUpperCase()}`;
}

export function getCounsellingStripePriceId(
    durationMinutes: DurationMinutes,
    isPremium: boolean
): string | null {
    const tier: PriceTier = isPremium ? 'premium' : 'standard';
    const id = process.env[counsellingStripePriceEnvKey(durationMinutes, tier)]?.trim();
    return id || null;
}

export function getAllCounsellingStripePriceIds(): string[] {
    const durations: DurationMinutes[] = [30, 45, 60];
    const tiers: PriceTier[] = ['standard', 'premium'];
    const ids: string[] = [];
    for (const duration of durations) {
        for (const tier of tiers) {
            const id = process.env[counsellingStripePriceEnvKey(duration, tier)]?.trim();
            if (id) ids.push(id);
        }
    }
    return ids;
}

export function isCounsellingStripePriceConfigured(
    durationMinutes: DurationMinutes,
    isPremium: boolean
): boolean {
    return getCounsellingStripePriceId(durationMinutes, isPremium) !== null;
}

function formatGbpPence(pence: number): string {
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP',
        minimumFractionDigits: pence % 100 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
    }).format(pence / 100);
}

function fallbackEntry(duration: DurationMinutes, isPremium: boolean): PriceEntry {
    const pence = isPremium
        ? FALLBACK_PREMIUM_PENCE[duration]
        : FALLBACK_STANDARD_PENCE[duration];
    return { pence, label: formatGbpPence(pence) };
}

async function fetchStripePriceEntry(
    duration: DurationMinutes,
    isPremium: boolean
): Promise<PriceEntry> {
    const priceId = getCounsellingStripePriceId(duration, isPremium);
    if (!priceId || !isStripeConfigured()) {
        return fallbackEntry(duration, isPremium);
    }

    try {
        const price = await getStripe().prices.retrieve(priceId);
        const pence = price.unit_amount;
        if (pence == null || !Number.isFinite(pence) || pence < 0) {
            return fallbackEntry(duration, isPremium);
        }
        const currency = (price.currency || 'gbp').toUpperCase();
        const label = new Intl.NumberFormat('en-GB', {
            style: 'currency',
            currency,
            minimumFractionDigits: pence % 100 === 0 ? 0 : 2,
            maximumFractionDigits: 2,
        }).format(pence / 100);
        return { pence, label };
    } catch (err) {
        console.error(
            '[counselling] Stripe price retrieve failed',
            priceId,
            err instanceof Error ? err.message : err
        );
        return fallbackEntry(duration, isPremium);
    }
}

export async function getPublicPriceTable(): Promise<{
    standard: Record<DurationMinutes, PriceEntry>;
    premium: Record<DurationMinutes, PriceEntry>;
}> {
    if (cachedTable && Date.now() < cachedTable.expires) {
        return { standard: cachedTable.standard, premium: cachedTable.premium };
    }

    const durations: DurationMinutes[] = [30, 45, 60];
    const standard = {} as Record<DurationMinutes, PriceEntry>;
    const premium = {} as Record<DurationMinutes, PriceEntry>;

    await Promise.all(
        durations.map(async (duration) => {
            const [std, prem] = await Promise.all([
                fetchStripePriceEntry(duration, false),
                fetchStripePriceEntry(duration, true),
            ]);
            standard[duration] = std;
            premium[duration] = prem;
        })
    );

    cachedTable = {
        expires: Date.now() + CACHE_MS,
        standard,
        premium,
    };

    return { standard, premium };
}

export async function getSessionPricePence(
    durationMinutes: DurationMinutes,
    isPremium: boolean
): Promise<number> {
    const table = await getPublicPriceTable();
    const entry = isPremium ? table.premium[durationMinutes] : table.standard[durationMinutes];
    return entry.pence;
}

export async function getSessionPriceLabel(
    durationMinutes: DurationMinutes,
    isPremium: boolean
): Promise<string> {
    const table = await getPublicPriceTable();
    const entry = isPremium ? table.premium[durationMinutes] : table.standard[durationMinutes];
    return entry.label;
}
