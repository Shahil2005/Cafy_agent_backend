import { z } from 'zod';
import { agentJobsClient, agentJobsDb } from '../jobs/db';
import { listUkSponsorshipRegister } from '../../jobs-portal/service';
import type { SponsorListCard } from '../contract';
import { cleanName, closestOption, coreName, matchName, splitTradingName, type MatchTier } from '../sponsors/match';
import { defineTool, type AgentTool } from './types';

/**
 * Searches the official UK Register of Licensed Sponsors (data/workers.csv, refreshed daily by
 * an existing GitHub Action and loaded by the existing read-only sponsor service). All rows and
 * routes are searchable; nothing is written anywhere.
 */

export interface RegisterRow {
    organisationName: string;
    townCity: string;
    county: string;
    typeRating: string;
    route: string;
}

export type RegisterLoader = () => Promise<RegisterRow[]>;
/** Brand → legal names from CAFY's companies table (read-only). */
export type AliasLookup = (name: string, signal: AbortSignal) => Promise<string[]>;

const MAX_RESULTS = 20;
const SOURCE = { label: 'UK Register of Licensed Sponsors', url: 'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers', date: 'updated daily' };

const TIER_RANK: Record<MatchTier, number> = { exact: 4, 'all-words': 3, prefix: 2, typo: 1 };

function rating(typeRating: string): 'A' | 'B' | undefined {
    const m = typeRating.match(/\(([AB])\s*rating\)/i);
    return m ? (m[1]!.toUpperCase() as 'A' | 'B') : undefined;
}

/** CAFY companies table lookup through the SELECT-only catalogue transport; failures just mean no aliases. */
const companiesAliasLookup: AliasLookup = async (name, signal) => {
    const safe = cleanName(name).slice(0, 60);
    if (!agentJobsDb() || safe.length < 3) return [];
    const db = agentJobsClient(signal);
    const { data, error } = await db
        .from('companies')
        .select('trading_name, companies_house_name')
        .or(`trading_name.ilike.%${safe}%,companies_house_name.ilike.%${safe}%`)
        .limit(10);
    if (error || !data) return [];
    return [...new Set((data as Array<{ trading_name?: string; companies_house_name?: string }>).map((r) => r.companies_house_name || '').filter(Boolean))];
};

interface Grouped {
    name: string;
    tradingAs?: string;
    town: string;
    county: string;
    rating?: 'A' | 'B';
    routes: Set<string>;
    tier?: MatchTier;
    score: number;
}

export function searchRegister(
    rows: RegisterRow[],
    query: { name?: string; aliases?: string[]; city?: string; county?: string; route?: string; rating?: 'A' | 'B' },
): { total: number; items: Grouped[]; route?: string } {
    const routes = [...new Set(rows.map((r) => r.route).filter(Boolean))];
    const route = query.route ? closestOption(query.route, routes) : undefined;
    const city = query.city ? cleanName(query.city) : '';
    const county = query.county ? cleanName(query.county) : '';
    const names = [query.name, ...(query.aliases ?? [])].filter((n): n is string => Boolean(n && n.trim()));
    const groups = new Map<string, Grouped>();
    // Cheap pre-filter: a name can only match if, for every query word, it has a word starting with
    // the same letter (typos almost never change the first letter). Skips ~95% of rows quickly.
    const JOINERS = new Set(['and', 'of', 'for', 'in', 'at', 'on']);
    const initials = names.map((n) => coreName(n).split(' ').filter((w) => w && !JOINERS.has(w)).map((w) => ` ${w[0]}`));
    const mayMatch = (organisation: string) => {
        const lower = ` ${organisation.toLowerCase().replace(/[^a-z0-9]+/g, ' ')}`;
        return initials.some((letters) => letters.every((l) => lower.includes(l)));
    };
    for (const row of rows) {
        if (names.length && !mayMatch(row.organisationName)) continue;
        if (route && row.route !== route) continue;
        if (query.rating && rating(row.typeRating) !== query.rating) continue;
        if (city && !cleanName(row.townCity).includes(city)) continue;
        if (county && !cleanName(row.county).includes(county)) continue;
        const { legal, trading } = splitTradingName(row.organisationName);
        let best: { tier: MatchTier; score: number } | null = names.length ? null : { tier: 'exact', score: 0.5 };
        for (const n of names) {
            for (const candidate of [legal, trading].filter((c): c is string => Boolean(c))) {
                const m = matchName(n, candidate);
                if (m && (!best || m.score > best.score)) best = m;
            }
        }
        if (!best) continue;
        const key = `${coreName(legal)}|${cleanName(row.townCity)}`;
        const existing = groups.get(key);
        if (existing) {
            if (row.route) existing.routes.add(row.route);
            existing.rating = existing.rating === 'A' || rating(row.typeRating) === 'A' ? 'A' : existing.rating ?? rating(row.typeRating);
            if (best.score > existing.score) Object.assign(existing, { tier: best.tier, score: best.score });
        } else {
            groups.set(key, {
                name: legal,
                tradingAs: trading,
                town: row.townCity,
                county: row.county,
                rating: rating(row.typeRating),
                routes: new Set(row.route ? [row.route] : []),
                tier: names.length ? best.tier : undefined,
                score: best.score,
            });
        }
    }
    const items = [...groups.values()].sort(
        (a, b) =>
            (b.tier ? TIER_RANK[b.tier] : 0) - (a.tier ? TIER_RANK[a.tier] : 0) ||
            b.score - a.score ||
            Number(b.rating === 'A') - Number(a.rating === 'A') ||
            a.name.localeCompare(b.name),
    );
    return { total: items.length, items, route };
}

function confidence(tier?: MatchTier): 'exact' | 'close' | 'possible' | undefined {
    if (!tier) return undefined;
    return tier === 'exact' || tier === 'all-words' ? 'exact' : tier === 'prefix' ? 'close' : 'possible';
}

/** "health and care", "skilled worker", "creative"… named in the message → that register route. */
export function routeInMessage(message: string, rows: RegisterRow[]): string | undefined {
    const text = ` ${cleanName(message)} `;
    const routes = [...new Set(rows.map((r) => r.route).filter(Boolean))];
    const hits = routes
        .map((route) => ({ route, core: cleanName(route).replace(/\bworker\b/g, '').replace(/\s+/g, ' ').trim() }))
        .filter((r) => r.core.length >= 5 && text.includes(` ${r.core} `))
        .sort((a, b) => b.core.length - a.core.length);
    if (hits[0]) return hits[0].route;
    // Visas sponsored under another licence route in the register.
    if (/\b(?:health and care|care worker|health care worker|nhs visa)\b/.test(text) && routes.includes('Skilled Worker')) return 'Skilled Worker';
    return undefined;
}

/** Explains register routes that differ from the visa name the user used. */
export function routeNote(message: string): string | undefined {
    if (/\b(?:health and care|care worker|health care worker)\b/i.test(message))
        return 'The Health and Care Worker visa is sponsored under the Skilled Worker licence, so the register lists these employers under "Skilled Worker".';
    return undefined;
}

export function createSponsorTools(deps: { load?: RegisterLoader; aliases?: AliasLookup } = {}): AgentTool[] {
    const load = deps.load ?? listUkSponsorshipRegister;
    const aliases = deps.aliases ?? companiesAliasLookup;

    const findSponsors = defineTool({
        name: 'find_sponsors',
        description:
            'Searches the official UK Register of Licensed Sponsors (every company and route). Use for "is X a sponsor", "sponsors in <city>", "<route> sponsors". Handles typos and trading names. A licence never means a specific job offers sponsorship.',
        args: z
            .object({
                name: z.string().trim().min(2).max(120).optional(),
                city: z.string().trim().min(2).max(80).optional(),
                county: z.string().trim().min(2).max(80).optional(),
                route: z.string().trim().min(2).max(80).optional(),
                rating: z.enum(['A', 'B']).optional(),
            })
            .strict(),
        label: (args) =>
            args.name ? `Checking the UK sponsor register for “${args.name.slice(0, 40)}”` : `Searching UK licensed sponsors${args.city ? ` in ${args.city}` : ''}`,
        async run(args, ctx) {
            if (!args.name && !args.city && !args.county && !args.route)
                return { error: 'NEED_CRITERIA', instruction: 'Ask for a company name, a town/city or a visa route.' };
            const rows = await load();
            // A route named in the message is applied even if the model did not pass it.
            const route = args.route ?? routeInMessage(ctx.userMessage ?? '', rows);
            if (route) args = { ...args, route };
            const brandNames = args.name ? await aliases(args.name, ctx.signal).catch(() => []) : [];
            const result = searchRegister(rows, { ...args, aliases: brandNames });
            const strong = result.items.filter((i) => !args.name || i.tier === 'exact' || i.tier === 'all-words');
            // A name with no strong match but several weaker ones: ask, never guess.
            const ambiguous = Boolean(args.name) && !strong.length && result.items.length > 1;
            const shown = (ambiguous ? result.items.slice(0, 5) : (strong.length ? strong : result.items)).slice(0, MAX_RESULTS);
            const card: SponsorListCard = {
                query: args.name ?? [args.route, args.city ?? args.county].filter(Boolean).join(' · '),
                total: ambiguous ? result.items.length : strong.length || result.items.length,
                items: shown.map((i) => ({
                    name: i.name,
                    ...(i.tradingAs ? { tradingAs: i.tradingAs } : {}),
                    town: i.town,
                    county: i.county,
                    ...(i.rating ? { rating: i.rating } : {}),
                    routes: [...i.routes].sort(),
                    ...(confidence(i.tier) ? { confidence: confidence(i.tier) } : {}),
                })),
                ...(ambiguous ? { didYouMean: shown.map((i) => `${i.name}${i.town ? ` (${i.town})` : ''}`) } : {}),
                ...(result.route ? { route: result.route } : {}),
                source: SOURCE,
            };
            if (shown.length) ctx.emit('sponsor-list', { kind: 'sponsorList', card });
            return {
                found: shown.length > 0,
                total: card.total,
                ...(ambiguous ? { ambiguous: true, instruction: 'Several companies match: ask which one the user means (the card shows the options).' } : {}),
                ...(shown.length
                    ? {}
                    : { instruction: 'Not found on the register. Say so plainly, suggest checking the spelling or the legal company name, and link the GOV.UK register.' }),
                results: shown.slice(0, 10).map((i) => ({ name: i.name, tradingAs: i.tradingAs, town: i.town, rating: i.rating, routes: [...i.routes], match: confidence(i.tier) })),
                routeUsed: result.route,
                ...(routeNote(ctx.userMessage ?? '') ? { routeNote: routeNote(ctx.userMessage ?? '') } : {}),
                ...(/\bsponsor (?:me|my|us)\b/i.test(ctx.userMessage ?? '')
                    ? { answerRule: 'The user asks whether this employer will sponsor THEM. Do not start with "Yes" or "No". State the licence fact first, then that sponsorship depends on the specific job and the employer\'s decision.' }
                    : {}),
                note: 'A sponsor licence means the employer CAN sponsor; it does not mean a given job offers sponsorship.',
                source: SOURCE,
            };
        },
    });

    return [findSponsors];
}

export const SPONSOR_TOOLS = createSponsorTools();
