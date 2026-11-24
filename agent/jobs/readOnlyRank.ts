/**
 * Job ranking for a database the agent may only READ (the live CAFY database).
 *
 * The testing copy ranks in SQL (supabase/testing/agent_match_jobs.sql) over stored job vectors. The live
 * database has neither, and nothing may be created or written there, so this file does the same work with
 * plain SELECTs and the embedding service:
 *   1. Candidates: jobs whose title or advert has one of the search words, with the filters applied; with
 *      no words (a place or job type alone), the newest jobs that pass the filters.
 *   2. The same filters as the SQL, checked again in code (location, remote, hybrid, pay, visa, ...).
 *   3. A shortlist by keyword hits, then meaning: each query vector against the opening piece of each advert.
 *   4. The SQL's order: half-point meaning bands, keywords inside a band, a small step down for jobs clearly
 *      above or below the CV's level, one advert per company and role.
 * If the embedding service fails, jobs are ordered by keywords and date instead, so the search still answers.
 */
import { cosine } from '../cv/embed';
import { jobText } from './pieces';
import type { RankedJob, RankRequest } from './search';

export interface CandidateJob {
    id: number;
    title: string;
    description?: string | null;
    department?: string | null;
    location?: string | null;
    all_locations?: string[] | null;
    salary?: string | null;
    job_type?: string | null;
    company_id?: number | null;
    created_at?: string | null;
    sponsorship_outcome?: string | null;
}

/** The filters searchJobs sends (filtersFor in search.ts). */
export interface RankFilters {
    location?: string;
    exclude_locations?: string[];
    remote?: boolean;
    hybrid?: boolean;
    job_types?: string[];
    min_pay?: number;
    visa?: boolean;
    company_ids?: number[];
    posted_within_days?: number;
    exclude_job_ids?: number[];
}

/**
 * Reads candidate jobs (SELECT only). `titles` (the role) are matched in job titles; `terms` (skills and words)
 * widen the search. Without titles, the terms are matched in titles; with neither, the newest jobs.
 */
export type CandidateLoader = (terms: string[], filters: RankFilters, signal: AbortSignal, titles?: string[]) => Promise<CandidateJob[]>;

export interface ReadOnlyRankDeps {
    load: CandidateLoader;
    embed: (texts: string[]) => Promise<number[][]>;
    now?: () => number;
}

/** Jobs read against the query vectors; the rest are ordered by keywords alone and come after them. */
export const MEANING_SHORTLIST = 60;
const MAX_TERMS = 8;
const DESCRIPTION_CHARS = 6000;

const GENERIC_UK = /^\s*(?:united kingdom|uk|england|scotland|wales|gb)?\s*$/i;
const REMOTE_TEXT = /fully remote|remote[- ]first|remote[- ]based|remote (?:role|position|working|job)|100% remote|work(?:ing)? from home|home[- ]based role/i;
const HYBRID_TEXT = /hybrid (?:working|role|position|model|pattern|basis|arrangement)/i;

/** Advertised pay in pounds: the salary field, else the first £ amount in the advert (as agent_job_pay). */
export function jobPay(salary?: string | null, description?: string | null): number | null {
    const amounts = [...(salary ?? '').matchAll(/£\s?([0-9][0-9,]{3,9})/g)].map((m) => Number(m[1]!.replace(/,/g, '')));
    if (amounts.length) return Math.max(...amounts) || null;
    const first = /£\s?([0-9][0-9,]{3,9})/.exec((description ?? '').slice(0, DESCRIPTION_CHARS));
    return first ? Number(first[1]!.replace(/,/g, '')) || null : null;
}

/** The SQL's filters, applied to a job read from the database. */
export function passesFilters(job: CandidateJob, f: RankFilters, now: number): boolean {
    const location = (job.location ?? '').toLowerCase();
    const loc = f.location?.trim().toLowerCase();
    if (loc) {
        const inPlaces = location.includes(loc) || (job.all_locations ?? []).some((a) => a.toLowerCase().includes(loc));
        const inAdvert = GENERIC_UK.test(job.location ?? '') && (job.description ?? '').slice(0, DESCRIPTION_CHARS).toLowerCase().includes(loc);
        if (!inPlaces && !inAdvert) return false;
    }
    if (f.exclude_locations?.some((x) => x && location.includes(x.toLowerCase()))) return false;
    if (f.remote && !/\bremote\b/i.test(job.location ?? '') && !REMOTE_TEXT.test(job.description ?? '')) return false;
    if (f.hybrid && !/\bhybrid\b/i.test(job.location ?? '') && !HYBRID_TEXT.test(job.description ?? '')) return false;
    if (f.job_types?.length && !f.job_types.includes(job.job_type ?? '')) return false;
    if (f.min_pay && (jobPay(job.salary, job.description) ?? 0) < f.min_pay) return false;
    // "Needs a visa" removes only jobs already found NOT eligible; "not sure" stays.
    if (f.visa && job.sponsorship_outcome === 'not_eligible') return false;
    if (f.company_ids?.length && (job.company_id == null || !f.company_ids.includes(job.company_id))) return false;
    if (f.posted_within_days && (!job.created_at || Date.parse(job.created_at) < now - f.posted_within_days * 86_400_000)) return false;
    if (f.exclude_job_ids?.includes(job.id)) return false;
    return true;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Share of the keywords found as whole words in the title, department or advert (the SQL's exact matches). */
export function keywordScore(job: CandidateJob, keywords: string[]): number {
    if (!keywords.length) return 0;
    const text = `${job.title} ${job.department ?? ''} ${job.description ?? ''}`;
    const hits = keywords.filter((k) => k.trim() && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(k.trim())}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text)).length;
    return hits / keywords.length;
}

/** Clear signs a job is above or below the CV's level (the SQL's rules); null when there is no CV or no sign. */
export function seniority(job: CandidateJob, cvYears: number | null): 'too_senior' | 'too_junior' | null {
    if (cvYears == null) return null;
    const title = job.title;
    if ((/\b(?:senior|sr|lead|principal|head of|director|chief|vp|vice president)\b/i.test(title) || /\bstaff\s+(?:\w+\s+)?(?:engineer|developer|scientist|architect)\b/i.test(title)) && cvYears < 5) return 'too_senior';
    if (/\b(?:ii|iii|iv)\b/i.test(title) && cvYears < 2) return 'too_senior';
    if (/\b(?:graduate|junior|jr|entry[- ]level|trainee|intern|internship|apprentice|apprenticeship)\b/i.test(title) && cvYears >= 4) return 'too_junior';
    const asked = /(\d{1,2})\s*\+?\s*(?:years|yrs)[^.\n]{0,40}experience/i.exec(`${title} ${job.department ?? ''} ${job.description ?? ''}`)?.[1];
    if (asked && Number(asked) >= cvYears + 2) return 'too_senior';
    return null;
}

/** Search words worth looking for in the database: distinct, plain, three letters or more. */
export function searchTerms(keywords: string[], max = MAX_TERMS): string[] {
    const plain = keywords.map((k) => k.toLowerCase().replace(/[^a-z0-9 +#&'.-]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((k) => k.length >= 3);
    return [...new Set(plain)].slice(0, max);
}

/** Title and opening of the advert: shorter than a stored piece, so a whole shortlist embeds in a few seconds. */
const MEANING_CHARS = 600;

/** The text a job is compared by: its title and department, then the start of the advert (as stored pieces begin). */
export function meaningText(job: CandidateJob): string {
    return jobText({ title: job.title, department: job.department ?? undefined, description: (job.description ?? '').slice(0, MEANING_CHARS * 2) }).slice(0, MEANING_CHARS);
}

const parseVector = (v: string): number[] => {
    try {
        const out = JSON.parse(v) as unknown;
        return Array.isArray(out) && out.every((x) => typeof x === 'number') ? out : [];
    } catch {
        return [];
    }
};

const sameRole = (job: CandidateJob) => `${job.company_id ?? `job${job.id}`}|${job.title.replace(/[([][^)\]]*[)\]]/g, ' ').trim().toLowerCase()}`;

/** Orders scored jobs as the SQL does and keeps one advert per company and role. */
export function orderJobs(scored: Array<{ job: CandidateJob; meaning: number; keyword: number; seniority: string | null }>, limit: number): RankedJob[] {
    const withBand = scored.map((s) => ({ ...s, band: Math.floor((s.meaning - (s.seniority ? 0.01 : 0)) * 200), time: Date.parse(s.job.created_at ?? '') || 0 }));
    withBand.sort((a, b) => b.band - a.band || b.keyword - a.keyword || b.meaning - a.meaning || b.time - a.time);
    const seen = new Set<string>();
    const out: RankedJob[] = [];
    for (const s of withBand) {
        const key = sameRole(s.job);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ job_id: s.job.id, meaning: s.meaning, keyword: s.keyword, seniority: s.seniority });
        if (out.length >= limit) break;
    }
    return out;
}

/** Vectors for adverts already read, so "more jobs" and repeat searches skip the embedding service. */
const vectorCache = new Map<string, number[]>();
const VECTOR_CACHE_SIZE = 5000;

async function vectorsFor(jobs: CandidateJob[], embed: ReadOnlyRankDeps['embed']): Promise<Map<number, number[]>> {
    const texts = jobs.map(meaningText);
    const out = new Map<number, number[]>();
    const missing: number[] = [];
    texts.forEach((text, i) => {
        const known = vectorCache.get(text);
        if (known) out.set(jobs[i]!.id, known);
        else missing.push(i);
    });
    if (missing.length) {
        const fresh = await embed(missing.map((i) => texts[i]!));
        missing.forEach((i, n) => {
            const v = fresh[n];
            if (!v?.length) return;
            out.set(jobs[i]!.id, v);
            if (vectorCache.size >= VECTOR_CACHE_SIZE) vectorCache.delete(vectorCache.keys().next().value!);
            vectorCache.set(texts[i]!, v);
        });
    }
    return out;
}

export async function rankByReading(request: RankRequest, signal: AbortSignal, deps: ReadOnlyRankDeps): Promise<RankedJob[]> {
    const now = (deps.now ?? Date.now)();
    const filters = request.filters as RankFilters;
    const terms = searchTerms(request.keywords);
    const titles = searchTerms(request.titles ?? [], 12);
    const loaded = await deps.load(terms, filters, signal, titles);
    const unique = [...new Map(loaded.map((job) => [job.id, job])).values()];
    const jobs = unique.filter((job) => passesFilters(job, filters, now));
    if (!jobs.length) return [];

    const keyword = new Map(jobs.map((job) => [job.id, keywordScore(job, request.keywords)]));
    // Jobs titled as the role come first; without a role, jobs with a search word in the title.
    const titleWords = titles.length ? titles : terms;
    const inTitle = (job: CandidateJob) => (titleWords.some((t) => job.title.toLowerCase().includes(t)) ? 1 : 0);
    const byKeywords = [...jobs].sort((a, b) => inTitle(b) - inTitle(a) || keyword.get(b.id)! - keyword.get(a.id)! || (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0));
    const shortlist = byKeywords.slice(0, MEANING_SHORTLIST);

    const query = request.query.map((q) => ({ v: parseVector(q.v), w: Math.max(q.w ?? 1, 0.01) })).filter((q) => q.v.length);
    let vectors = new Map<number, number[]>();
    if (query.length) {
        try {
            vectors = await vectorsFor(shortlist, deps.embed);
        } catch (error) {
            if (signal.aborted) throw error;
            console.warn('[agent] job meaning unavailable; ranking live jobs by keywords', { message: (error as Error).message.slice(0, 80) });
        }
    }
    const meaningOf = (job: CandidateJob) => {
        const v = vectors.get(job.id);
        if (!v) return 0;
        const total = query.reduce((sum, q) => sum + q.w, 0);
        return query.reduce((sum, q) => sum + cosine(q.v, v) * q.w, 0) / total;
    };
    const scored = shortlist.map((job) => ({ job, meaning: meaningOf(job), keyword: keyword.get(job.id)!, seniority: seniority(job, request.cvYears) }));
    // Past the shortlist: keyword order, after every read job, so "more jobs" still has somewhere to go.
    const rest = byKeywords.slice(MEANING_SHORTLIST).map((job) => ({ job, meaning: 0, keyword: keyword.get(job.id)!, seniority: seniority(job, request.cvYears) }));
    return orderJobs([...scored, ...rest], request.limit);
}
