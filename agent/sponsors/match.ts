/**
 * Name matching for the UK Register of Licensed Sponsors, done by code ($0, no AI):
 * normalisation, trading-name aliases, exact → all-words → prefix → typo-tolerant tiers.
 * Names have no "meaning" to embed, so vectors are deliberately not used here.
 */

const NOISE = new Set([
    'ltd', 'limited', 'plc', 'llp', 'lp', 'llc', 'inc', 'uk', 'u.k', 'gb', 'group', 'holdings', 'holding', 'the',
    'co', 'company', 'services', 'service', 'international', 'intl', 'europe', 'trading', 'enterprises',
]);

/** Lowercase, accents and punctuation removed, "&" → "and". */
export function cleanName(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Clean name without legal suffixes and filler words; falls back to the clean name if nothing is left. */
export function coreName(value: string): string {           
    const clean = cleanName(value);
    const core = clean.split(' ').filter((w) => w && !NOISE.has(w)).join(' ');
    return core || clean;
}

const TRADING_AS = /\s+(?:t\/a|t\/as|ta|trading as|t\.a\.)\s+/i;

/** "Example Ltd t/a Brand" → legal name + trading name, both searchable. */
export function splitTradingName(name: string): { legal: string; trading?: string } {
    const parts = name.split(TRADING_AS);
    if (parts.length < 2) return { legal: name.trim() };
    return { legal: parts[0]!.trim(), trading: parts.slice(1).join(' ').trim() || undefined };
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps), capped for speed. */
export function editDistance(a: string, b: string, max = 3): number {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) {
        let rowMin = Infinity;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
            d[i]![j] = v;
            rowMin = Math.min(rowMin, v);
        }
        if (rowMin > max) return max + 1;
    }
    return d[a.length]![b.length]!;
}

/** Typos allowed per word: none under 4 letters, 1 for 4–7, 2 for 8+. */
function allowedTypos(word: string): number {
    return word.length < 4 ? 0 : word.length < 8 ? 1 : 2;
}

function trigrams(value: string): Set<string> {
    const padded = `  ${value} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
    return out;
}

export function trigramSimilarity(a: string, b: string): number {
    const A = trigrams(a);
    const B = trigrams(b);
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    return shared / (A.size + B.size - shared || 1);
}

export type MatchTier = 'exact' | 'all-words' | 'prefix' | 'typo';

/**
 * How well a query matches one name. Returns null for no match.
 * Every query word must match some name word (exactly, as a prefix, or within the typo allowance).
 */
export function matchName(query: string, name: string): { tier: MatchTier; score: number } | null {
    const q = coreName(query);
    const n = coreName(name);
    if (!q || !n) return null;
    if (q === n) return { tier: 'exact', score: 1 };
    const qWords = q.split(' ');
    const nWords = n.split(' ');
    const nSet = new Set(nWords);
    if (qWords.every((w) => nSet.has(w))) return { tier: 'all-words', score: 0.9 - Math.min(0.2, (nWords.length - qWords.length) * 0.03) };
    if (n.startsWith(q)) return { tier: 'prefix', score: 0.8 };
    // Typo tolerance: each query word must be close to a different-or-same name word.
    let typos = 0;
    for (const w of qWords) {
        let best = Infinity;
        for (const nw of nWords) {
            if (nw.startsWith(w) && w.length >= 3) {
                best = 0;
                break;
            }
            const limit = allowedTypos(w);
            if (!limit) continue;
            best = Math.min(best, editDistance(w, nw, limit));
        }
        if (best > allowedTypos(w)) return null;
        typos += best;
    }
    const similarity = trigramSimilarity(q, n);
    if (similarity < 0.25 && typos > 0) return null;
    return { tier: 'typo', score: Math.max(0.3, 0.75 - typos * 0.1) * (0.6 + 0.4 * similarity) };
}

/** Best fuzzy pick from a small list of options (routes, cities), or undefined. */
export function closestOption(value: string, options: string[]): string | undefined {
    const v = cleanName(value);
    if (!v) return undefined;
    let best: { option: string; score: number } | undefined;
    for (const option of options) {
        const o = cleanName(option);
        if (o === v) return option;
        const score = o.includes(v) || v.includes(o) ? 0.9 : trigramSimilarity(v, o);
        if (!best || score > best.score) best = { option, score };
    }
    return best && best.score >= 0.45 ? best.option : undefined;
}
