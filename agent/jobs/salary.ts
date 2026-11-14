/**
 * Advertised pay from the job catalogue, worked out by code. Only a clear yearly pound figure counts;
 * hourly, daily, weekly and monthly pay, other currencies and bonus-only text are skipped, never converted.
 */

/** Below this many usable adverts a median says more about the sample than about the market. */
export const MIN_PAY_SAMPLES = 8;
const MIN_YEARLY = 10_000;
const MAX_YEARLY = 500_000;

const NOT_YEARLY = /(?:\b(?:per|an?|each)\s+(?:hour|hr|day|week|wk|month)\b|\/\s*(?:hour|hr|h|day|week|wk|month|mo)\b|\b(?:hourly|daily|weekly|monthly)\b|\bp\.?\s?(?:h|d|w|m)\.?\b(?!\w))/i;
const NOT_POUNDS = /(?:\$|€|\busd\b|\beur\b)/i;
const PRO_RATA = /\b(?:pro[- ]?rata|fte|full[- ]time equivalent|ote|on[- ]target earnings)\b/i;
const POUND_AMOUNT = /£\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/gi;

function toNumber(raw: string, thousands: boolean): number | undefined {
    const n = Number.parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return thousands ? n * 1000 : n;
}

/** The yearly pay in pounds (the middle of a range), or null when the text is not a clear yearly figure. */
export function yearlyPay(salary?: string | null): number | null {
    if (!salary) return null;
    const text = salary.replace(/\s+/g, ' ').trim();
    if (!text || NOT_POUNDS.test(text) || NOT_YEARLY.test(text) || PRO_RATA.test(text)) return null;
    // "75000 - 115000 GBP Annual": pounds named as a word, with bare figures.
    if (GBP_WORD.test(text) && !text.includes('£')) return middleOf([...text.matchAll(BARE_AMOUNT)].flatMap((m) => {
        const value = toNumber(m[1]!, Boolean(m[2]));
        return value === undefined ? [] : [value];
    }));
    const amounts = [...text.matchAll(POUND_AMOUNT)].flatMap((m) => {
        const value = toNumber(m[1]!, Boolean(m[2]));
        return value === undefined ? [] : [value];
    });
    // "£30,000 - £40,000" is a range. A range written "£30,000 - 40,000" has one pound sign: read the bare number too.
    const bare = /£\s*\d[\d,]*(?:\.\d+)?\s*k?\s*(?:-|–|to)\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?/i.exec(text);
    if (bare && amounts.length === 1) {
        const upper = toNumber(bare[1]!, Boolean(bare[2]) || (amounts[0]! < 1000 && Number(bare[1]!.replace(/,/g, '')) < 1000));
        if (upper !== undefined) amounts.push(upper);
    }
    return middleOf(amounts);
}

const GBP_WORD = /\bGBP\b/i;
const BARE_AMOUNT = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)\s*(k)?(?![\d.,])/gi;

/** One figure or a low–high range, as a yearly amount in the plausible range; anything else is not trusted. */
function middleOf(amounts: number[]): number | null {
    if (amounts.length === 0 || amounts.length > 2) return null;
    const [low, high = low] = amounts as [number, number?];
    if (low > high) return null;
    const middle = (low + high) / 2;
    return middle >= MIN_YEARLY && middle <= MAX_YEARLY ? Math.round(middle) : null;
}

export interface PayStats {
    samples: number;
    median: number;
    lowerQuartile: number;
    upperQuartile: number;
    lowest: number;
    highest: number;
}

function percentile(sorted: number[], fraction: number): number {
    const position = (sorted.length - 1) * fraction;
    const below = Math.floor(position);
    const above = Math.ceil(position);
    return Math.round(sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below));
}

/** Level words are left out, so "Junior Data Analyst" compares with every data analyst advert, senior ones too. */
const LEVEL_WORDS = /\b(?:junior|jr|graduate|grad|trainee|intern(?:ship)?|apprentice(?:ship)?|assistant|associate|senior|sr|lead|principal|head of|entry[- ]level)\b/gi;

/** The role to compare pay for: the latest paid job (or internship) on the CV, else its headline. */
export function payRoleFromCv(profile: { headline: string; roles: Array<{ title: string; type: string }> }): string | undefined {
    const title = profile.roles.find((role) => role.type === 'job')?.title ?? profile.roles.find((role) => role.type === 'internship')?.title ?? profile.headline;
    const role = (title ?? '').toLowerCase().replace(LEVEL_WORDS, ' ').replace(/[^a-z0-9+#& -]+/g, ' ').replace(/\s+/g, ' ').trim();
    return role.length >= 3 ? role : undefined;
}

/** A title above entry or mid level: senior, lead, staff, principal, head, manager, director, or a grade II–IV. */
export function isHigherLevel(title: string): boolean {
    return /\b(?:senior|sr|lead|staff|principal|head|manager|director|chief|vp)\b|\b(?:ii|iii|iv)\b/i.test(title);
}

export interface BetterPaidGroup {
    title: string;
    adverts: number;
    typicalPay: number;
    ids: number[];
}

/** Adverts paying at least the upper quartile, one entry per title (bracketed codes ignored), best paid first. */
export function betterPaid(adverts: Array<{ id: number; title: string; salary: string }>, stats: Pick<PayStats, 'upperQuartile'>, limit = 6): BetterPaidGroup[] {
    const groups = new Map<string, { title: string; pays: number[]; ids: number[] }>();
    for (const advert of adverts) {
        const pay = yearlyPay(advert.salary);
        if (pay === null || pay < stats.upperQuartile) continue;
        const title = advert.title.replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
        const key = title.toLowerCase();
        const group = groups.get(key) ?? { title, pays: [], ids: [] };
        group.pays.push(pay);
        group.ids.push(advert.id);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((g) => ({ title: g.title, adverts: g.pays.length, typicalPay: payStats(g.pays, 1)!.median, ids: g.ids }))
        .sort((a, b) => b.typicalPay - a.typicalPay || b.adverts - a.adverts)
        .slice(0, limit);
}

/** Null when there are too few usable adverts to say anything honest. */
export function payStats(values: number[], minimum = MIN_PAY_SAMPLES): PayStats | null {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length < minimum) return null;
    return {
        samples: sorted.length,
        median: percentile(sorted, 0.5),
        lowerQuartile: percentile(sorted, 0.25),
        upperQuartile: percentile(sorted, 0.75),
        lowest: sorted[0]!,
        highest: sorted[sorted.length - 1]!,
    };
}
