import { z } from 'zod';
import { createHash } from 'node:crypto';
import { embedTexts } from '../cv/embed';
import { cached, cacheKey, peekCached, saveCached, withinMs } from '../cache';
import { CvTextMatcher } from '../cv/profile';
import { experienceYears } from '../cv/years';
import {
    companyIdsFromDatabase,
    titleJobsFromDatabase,
    createJobExplainer,
    displaySalary,
    bestFirst,
    hardGapIn,
    honestSummary,
    RESULTS_PER_PAGE,
    jobDetailsFromDatabase,
    jobVerdict,
    jobVisaFacts,
    jobSearchSettingsSchema,
    type JobSearchSettings,
    rankWithDatabase,
    realGaps,
    searchJobs,
    type JobSearchDeps,
    type JobDetail,
} from '../jobs/search';
import { isJobsForMe } from '../cvIntent';
import { asksAboutSoc } from '../routing';
import { socFactsCard } from './uk';
import type { JobListCard } from '../contract';
import { defineTool, type AgentTool, type ToolContext } from './types';

const EMBED_CACHE_SECONDS = 30 * 24 * 60 * 60;
/** One short text normally embeds in under a second; the embedding service has no time limit of its own. */
const EMBED_TIMEOUT_MS = 15_000;
const isVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 384 && value.every((x) => typeof x === 'number');

const defaultDeps: JobSearchDeps = {
    rank: rankWithDatabase,
    details: jobDetailsFromDatabase,
    companyIds: companyIdsFromDatabase,
    titleJobs: titleJobsFromDatabase,
    // The same search text always gets the same vector, so it is kept for a month (no personal data: role names and advert text).
    embed: (text) => cached(cacheKey('embed', text), EMBED_CACHE_SECONDS, async () => (await withinMs(embedTexts([text]), EMBED_TIMEOUT_MS, 'Embedding'))[0]!, { valid: isVector }),
    // Cached pieces come from the cache; the rest go to the embedding service together, in its batches.
    embedMany: async (texts) => {
        const known = await Promise.all(texts.map((text) => peekCached(cacheKey('embed', text), isVector)));
        const missing = texts.filter((_, i) => !known[i]);
        const fresh = missing.length ? await withinMs(embedTexts(missing), EMBED_TIMEOUT_MS, 'Embedding') : [];
        let next = 0;
        return texts.map((text, i) => {
            if (known[i]) return known[i]!;
            const vector = fresh[next++]!;
            saveCached(cacheKey('embed', text), EMBED_CACHE_SECONDS, vector);
            return vector;
        });
    },
    explain: createJobExplainer(),
};

/**
 * The AI understands the request; these keep it from carrying things over that the user did not say.
 * A place counts only if this message names it (loosely, for typos), unless this is a refinement of the last search.
 */
export function searchSettings(input: { refine?: boolean; more?: boolean; args: JobSearchSettings; previous?: Record<string, unknown>; message: string; cv: ToolContext['cv'] }): JobSearchSettings {
    const { refine, more, args, previous, message, cv } = input;
    const lower = message.toLowerCase();
    const settings: JobSearchSettings = (refine || more) && previous && !args.role ? { ...(previous as JobSearchSettings), ...args } : { ...args };
    if (!refine && !more && args.location && !lower.includes(args.location.toLowerCase().slice(0, 3))) delete settings.location;
    // A job type is a real filter that hides jobs, so it counts only if this message asks for one.
    if (!refine && !more && args.jobTypes && !/part|full|contract|intern|placement|temp|perm/.test(lower)) delete settings.jobTypes;
    // Their own job title is not a request for that title: with no role asked for, the whole CV is the query.
    const said = (word: string) => lower.includes(word.slice(0, 4));
    const ownTitle = cv && args.role && settings.role && [cv.profile.headline, ...cv.profile.roles.map((r) => r.title)].some((t) => t.toLowerCase().includes(settings.role!.toLowerCase()));
    if (ownTitle && !settings.role!.toLowerCase().split(/\s+/).some(said)) delete settings.role;
    return settings;
}

const MAX_COUNT = 10;
/** The model may pass what the user asked for ("20 jobs"); jobs are still shown 10 at a time, and the answer says so. */
const MAX_ASKED = 50;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const ASKED_COUNT = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)\s+(?:more\s+)?(?:[a-z-]+\s+){0,3}?(?:jobs?|roles?|positions?|vacancies|openings|options)\b/i;

/** "Give me 20 most suitable jobs": how many jobs the user asked for, if they said. */
export function askedJobCount(message: string): number | undefined {
    const match = ASKED_COUNT.exec(message);
    if (!match) return undefined;
    const word = match[1]!.toLowerCase();
    return NUMBER_WORDS[word] ?? Number(word);
}

/** The search on screen asked again: the same role, filters and advert (none given means the same CV search). */
function sameSearch(previous: Record<string, unknown>, args: JobSearchSettings, advert?: string): boolean {
    if (advert && advert !== previous.advert) return false;
    const norm = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : JSON.stringify(value ?? null));
    const keys = new Set([...Object.keys(previous), ...Object.keys(args)].filter((key) => key !== 'advert'));
    return [...keys].every((key) => norm(previous[key]) === norm((args as Record<string, unknown>)[key]));
}

/** Jobs are read against the CV ten at a time; asked for more, the answer must say so rather than quietly show ten. */
function pageNote(asked: number | undefined, next = false): string {
    if (!asked || asked <= RESULTS_PER_PAGE) return '';
    return ` They asked for ${asked} jobs. Say plainly that you show jobs 10 at a time, that these are the ${next ? 'next' : 'first'} 10, and that they can say "more" for the next 10.`;
}
/** Enough to find the best few without reading the whole page closely. */
const RECOMMEND_FROM = 5;

function paidYears(ctx: ToolContext): number | null {
    // Paid jobs and internships only; no usable dates means no level check rather than a wrong one.
    const worked = ctx.cv ? experienceYears(ctx.cv.profile.roles.filter((r) => r.type === 'job' || r.type === 'internship')) : null;
    return worked && worked.totalMonths > 0 ? worked.years : null;
}

/**
 * What this message itself names. "Jobs for my CV" starts again from the CV, so a role or filter from an
 * earlier search must not come along, even if the model carries it over.
 */
function namedInMessage(args: JobSearchSettings, message: string): JobSearchSettings {
    const lower = message.toLowerCase();
    const has = (pattern: RegExp) => pattern.test(lower);
    const settings: JobSearchSettings = {};
    if (args.role && lower.includes(args.role.toLowerCase().split(/\s+/)[0]!.slice(0, 4))) settings.role = args.role;
    if (args.company && lower.includes(args.company.toLowerCase().slice(0, 4))) settings.company = args.company;
    if (args.location && lower.includes(args.location.toLowerCase().slice(0, 3))) settings.location = args.location;
    if (args.excludeLocations && has(/\b(?:not|outside|except|excluding)\b/)) settings.excludeLocations = args.excludeLocations;
    if (args.remote && has(/remote|from home/)) settings.remote = true;
    if (args.hybrid && has(/hybrid/)) settings.hybrid = true;
    if (args.jobTypes && has(/part|full|contract|intern|placement/)) settings.jobTypes = args.jobTypes;
    if (args.minPay && has(/\d/)) settings.minPay = args.minPay;
    if (args.needsVisa && has(/visa|sponsor/)) settings.needsVisa = true;
    if (args.postedWithinDays && has(/week|day|month|recent|new/)) settings.postedWithinDays = args.postedWithinDays;
    return settings;
}

export function listAt(ctx: ToolContext, list = 0): JobListCard | undefined {
    if (list) {
        // "Compare job 1 and job 2" means the newest list unless they point to an older one.
        const message = (ctx.userMessage ?? '').toLowerCase();
        const namesIt = ctx.jobLists?.[list]?.query.toLowerCase().split(/\W+/).some((word) => word.length >= 4 && word !== 'jobs' && message.includes(word));
        if (/\bjobs?\s*(?:no\.?\s*|number\s*|#\s*)?\d/.test(message) && !/\b(?:before|earlier|previous|prior|last|first|old|other)\b/.test(message) && !namesIt) list = 0;
    }
    return list ? ctx.jobLists?.[list] : ctx.lastJobs ?? ctx.jobLists?.[0];
}

/** What the AI needs in order to explain a recommendation; the figures stay on the card. */
const pickSummary = (job: JobListCard['items'][number]) => ({ title: job.title, company: job.company, location: job.location, verdict: job.verdict, summary: job.summary, matches: job.have, missing: job.missing, levelNote: job.levelNote });

/** The job being discussed, as a card with its advert link, so the answer never has to carry the link itself. */
function showJobCard(ctx: ToolContext, list: JobListCard | undefined, id: number): void {
    const item = list?.items.find((j) => j.id === id);
    if (list && item) ctx.emit(`job-${id}`, { kind: 'jobList', card: { ...list, pick: true, hidden: false, fewCloseMatches: false, query: item.title, items: [item] } });
}

/**
 * A pasted advert as a job to read against the CV. Its id is negative and comes from its text, so the
 * one-reading-per-job cache never mixes two adverts or an advert with a catalogue job.
 */
export function pastedAdvertJob(advert: string): JobDetail {
    const firstLine = advert.split('\n').map((line) => line.trim()).find(Boolean) ?? 'The advert you shared';
    const id = -(Number.parseInt(createHash('sha256').update(advert).digest('hex').slice(0, 12), 16) || 1);
    return { id, title: firstLine.slice(0, 120), description: advert, sponsor: false };
}

const PICK_INSTRUCTION = 'The cards show these jobs with their links; do not list them. Say which job you recommend and why in a few sentences, using its verdict, its CV quotes and its real gaps. Say plainly if it is a stretch. Never promise a job.';

export function createJobTools(deps: JobSearchDeps = defaultDeps): AgentTool[] {
    const searchTool = defineTool({
        name: 'search_jobs',
        description:
            'Finds real open UK jobs from CAFY\'s catalogue and shows them as cards. With no role it matches the selected CV. Use role only in the user\'s own words (e.g. "data"), never narrower. Set refine true to change the previous search ("only remote"), more true for the next results, count when they ask for a number of jobs or the best one. jobTypes is a list of: full-time, part-time, contract, internship, placement. minPay is yearly pounds as a number. excludeLocations is a list of places.',
        args: jobSearchSettingsSchema.extend({ refine: z.boolean().optional(), more: z.boolean().optional(), count: z.number().int().min(1).max(MAX_ASKED).optional() }).strict(),
        label: (args) => (args.role ? `Searching all jobs for “${args.role.slice(0, 40)}”` : 'Comparing your CV with every open job'),
        async run({ refine, more, count: askedCount, ...args }, ctx) {
            // More than a page is shown as the full page, with a note that the rest comes with "more".
            const asked = Math.max(askedCount ?? 0, askedJobCount(ctx.userMessage ?? '') ?? 0) || undefined;
            let count = askedCount && askedCount <= MAX_COUNT ? askedCount : undefined;
            const previous = ctx.lastJobs;
            // "Give me 20" while the first 10 of this same search are on screen: the next 10, never the same 10 again.
            if (!more && !refine && asked && asked > RESULTS_PER_PAGE && previous && !previous.pick && previous.items.length >= RESULTS_PER_PAGE && sameSearch(previous.search, args, ctx.advert)) more = true;
            // "Jobs like this advert": the advert's whole text is the query. Its place, pay, company and type are
            // facts about that one job, not the user's request, so filters come only from the user's own words.
            // "More" or "only remote" afterwards searches the same advert again.
            const storedAdvert = typeof previous?.search.advert === 'string' ? previous.search.advert : undefined;
            const advert = ctx.advert ?? ((refine || more) && !args.role ? storedAdvert : undefined);
            // A new role is a new search: filters from the old one do not carry over, whatever the model says.
            // "Jobs for my CV" after other searches: back to the CV, with no old role or filters.
            const backToCv = !ctx.advert && isJobsForMe(ctx.userMessage ?? '') && !more;
            const settings: JobSearchSettings = ctx.advert
                ? { ...namedInMessage(args, ctx.userMessage ?? ''), ...(args.role ? { role: args.role } : {}) }
                : backToCv
                  ? namedInMessage(args, ctx.userMessage ?? '')
                  : searchSettings({ refine, more, args, previous: previous?.search, message: ctx.userMessage ?? '', cv: ctx.cv });
            delete (settings as Record<string, unknown>).advert;
            // A number asked for earlier does not carry into "jobs for my CV".
            if (backToCv && !/\b(?:\d+|one|best|top|single)\b/i.test(ctx.userMessage ?? '')) count = undefined;
            // "Not in London" must not also search in London.
            if (settings.location && settings.excludeLocations?.some((place) => place.toLowerCase() === settings.location!.toLowerCase())) delete settings.location;
            const years = paidYears(ctx);
            let outcome: Awaited<ReturnType<typeof searchJobs>>;
            try {
                outcome = await searchJobs(settings, {
                    cv: ctx.cv,
                    years,
                    excludeJobIds: more ? previous?.shownIds : undefined,
                    signal: ctx.signal,
                    ...(advert ? { advert } : {}),
                    // The full list shows at once and is updated in place when the CV reading is done. A short pick waits, as it depends on that reading.
                    ...(count ? {} : { onCards: (card: JobListCard) => ctx.emit('job-list', { kind: 'jobList', card }) }),
                }, deps);
            } catch (error) {
                if (ctx.signal.aborted) throw error;
                return { error: 'SEARCH_SLOW', instruction: 'Say the search took too long this time and to try again in a moment. Do not guess why, and do not ask them to change what they asked for. Never say a tool is unavailable and never list jobs from memory.' };
            }
            if (outcome.status === 'need_cv_or_role') {
                return { error: 'NEED_CV_OR_ROLE', instruction: 'Ask what kind of job they want, or to choose one of their saved CVs. Do not list example jobs.' };
            }
            if (outcome.status === 'no_company') {
                return { error: 'COMPANY_NOT_FOUND', instruction: `Say no open jobs from "${outcome.company}" are in the catalogue. Do not invent any.` };
            }
            if (outcome.status === 'no_jobs') {
                return {
                    error: more ? 'NO_MORE_JOBS' : 'NO_JOBS',
                    settings: outcome.settings,
                    instruction: more
                        ? 'Say these are all the close matches for now, and offer to widen the search.'
                        : 'Say no open jobs match these filters right now. Name the filters and suggest loosening one. Do not invent jobs and do not send them to job boards.',
                };
            }
            // Fewer than a page: keep the list for "job 2" and "more", but show only what they asked for.
            if (count && count < outcome.card.items.length) {
                const chosen = bestFirst(outcome.card.items).slice(0, count);
                ctx.emit('job-list', { kind: 'jobList', card: { ...outcome.card, hidden: true } });
                ctx.emit('job-pick', { kind: 'jobList', card: { ...outcome.card, pick: true, shortlist: true, query: count === 1 ? 'Closest match' : `Your top ${count}`, items: chosen } });
                return { count: chosen.length, jobs: chosen.map(pickSummary), instruction: PICK_INSTRUCTION };
            }
            ctx.emit('job-list', { kind: 'jobList', card: outcome.card }, { replace: true });
            return {
                // First, so a cut-down long result still carries it.
                ...(settings.remote ? { remoteFilter: true } : {}),
                count: outcome.card.items.length,
                jobs: outcome.card.items.map((job, i) => ({ position: i + 1, title: job.title, company: job.company, location: job.location, levelNote: job.levelNote, verdict: job.verdict, summary: job.summary, matches: job.have, missing: job.missing })),
                fewCloseMatches: outcome.card.fewCloseMatches,
                instruction: (outcome.card.fewCloseMatches
                    ? 'The cards show these jobs; do not list them. Say plainly that the catalogue has few close matches right now, so these are the nearest ones. Name no role or field you were not told. Never call them a strong fit.'
                    : 'The cards show these jobs; do not list them. Say in two or three sentences what came up. If summaries are given, name the closest job and why, in one sentence. Never call a job a guaranteed fit.') + pageNote(asked, Boolean(more))
                    + (outcome.byTitle ? ' The full ranking was slow this time, so these jobs were found by their job title only. Say so in one short sentence, and that asking again in a minute gives the fully ranked list.' : ''),
            };
        },
    });

    const recommendTool = defineTool({
        name: 'recommend_jobs',
        description: 'Picks the best jobs from a list already on screen by reading them against the CV, and shows only those. Use when they ask for one job, the best one or a number of jobs and a list exists. exclude takes the positions of jobs they do not want ("other than this"). Does not search again.',
        args: z.object({ count: z.number().int().min(1).max(MAX_ASKED).default(1), list: z.number().int().min(0).max(2).optional(), exclude: z.array(z.number().int().min(1).max(50)).max(20).optional() }).strict(),
        label: (args) => (args.count === 1 ? 'Finding your closest match' : `Finding your top ${args.count}`),
        maxResultChars: 9_000,
        async run(args, ctx) {
            if (!ctx.cv) return { error: 'NEED_CV', instruction: 'Ask them to choose one of their saved CVs so you can compare it with these jobs.' };
            // "Give me jobs for my CV" wants the list, however many they asked for earlier.
            if (isJobsForMe(ctx.userMessage ?? '') && !/\b(?:\d+|one|best|top|single)\b/i.test(ctx.userMessage ?? '')) return searchTool.run({}, ctx);
            const list = listAt(ctx, args.list);
            if (!list?.items.length) return { error: 'NO_LIST', instruction: 'There is no list yet. Call search_jobs with count instead.' };
            // "Give me 20" with 10 on screen: re-ranking those 10 adds nothing. The next 10 are what was asked for.
            const asked = Math.max(args.count, askedJobCount(ctx.userMessage ?? '') ?? 0);
            if (asked > list.items.length && !list.pick) {
                const next = (await searchTool.run({ more: true }, ctx)) as Record<string, unknown>;
                if (typeof next.instruction === 'string') next.instruction += ` These are the next jobs after the ${list.items.length} already shown, so together they are the closest ${list.items.length + Number(next.count ?? 0)}.` + pageNote(asked, true);
                return next;
            }
            // "Other than this": jobs already recommended or named by position are not offered again.
            const wantsAnother = /\b(?:other|another|different|else|next)\b/i.test(ctx.userMessage ?? '');
            const skip = new Set([...(args.exclude ?? []).map((position) => list.items[position - 1]?.id), ...(wantsAnother ? list.recommendedIds ?? [] : [])]);
            const open_ = list.items.filter((j) => !skip.has(j.id));
            if (!open_.length) return { error: 'NO_MORE_JOBS', instruction: 'Say those are all the jobs on this list, and offer a new search.' };
            const top = open_.slice(0, Math.max(RECOMMEND_FROM, Math.min(args.count, MAX_COUNT)));
            const details = await deps.details(top.map((j) => j.id), ctx.signal);
            const open = top.flatMap((j) => { const d = details.find((x) => x.id === j.id); return d ? [{ item: j, detail: d }] : []; });
            if (!open.length) return { error: 'JOB_CLOSED', instruction: 'Say these jobs are no longer in the catalogue, and offer a new search.' };
            const fits = await deps.explain(ctx.cv, open.map((o) => o.detail), ctx.signal).catch(() => []);
            const matcher = new CvTextMatcher(ctx.cv.text);
            const years = paidYears(ctx);
            const read = open.map(({ item, detail }) => {
                const fit = fits.find((f) => f.id === item.id);
                const have = (fit?.have ?? []).filter((h) => h.quote && matcher.contains(h.quote));
                const missing = realGaps(fit?.missing ?? [], ctx.cv!.text);
                const verdict = jobVerdict({ advert: detail.description, have: have.length, missing: missing.length, hardGap: hardGapIn(missing), years, tooSenior: Boolean(item.levelNote?.startsWith('May need')) });
                return { ...item, summary: honestSummary(fit?.summary ?? item.summary, verdict.label), have, missing, verdict };
            });
            const chosen = bestFirst(read).slice(0, args.count);
            ctx.emit('job-pick', { kind: 'jobList', card: { ...list, pick: true, shortlist: true, hidden: false, fewCloseMatches: false, query: args.count === 1 ? 'Closest match' : `Your top ${args.count}`, items: chosen } });
            return { count: chosen.length, jobs: chosen.map(pickSummary), instruction: PICK_INSTRUCTION };
        },
    });

    const fitTool = defineTool({
        name: 'job_fit',
        description: 'Compares one job with the selected CV: what matches with CV quotes, and what is missing. Use for "does job 2 suit me", "why did you recommend this". Leave position out to compare the job advert the user pasted in this message ("does my CV fit this?"). Never search again for this.',
        args: z.object({ position: z.number().int().min(1).max(50).optional(), list: z.number().int().min(0).max(2).optional() }).strict(),
        label: (args) => (args.position ? `Comparing job ${args.position} with your CV` : 'Comparing the advert with your CV'),
        maxResultChars: 12_000,
        async run(args, ctx) {
            if (!ctx.cv) return { error: 'NEED_CV', instruction: 'Ask them to choose one of their saved CVs so you can compare it with this job.' };
            const listed = args.position ? listAt(ctx, args.list)?.items[args.position - 1] : undefined;
            // A pasted advert is read as it is: it has no card, link or catalogue facts.
            const pastedJob = !listed && ctx.advert ? pastedAdvertJob(ctx.advert) : undefined;
            const id = listed?.id;
            if (!id && !pastedJob) return { error: 'NO_SUCH_JOB', instruction: 'Say you cannot tell which job they mean, and ask them to pick one from the cards or paste the advert.' };
            const [job] = pastedJob ? [pastedJob] : await deps.details([id!], ctx.signal);
            if (!job) return { error: 'JOB_CLOSED', instruction: 'Say this job is no longer in the catalogue, so it may have closed.' };
            if (id) showJobCard(ctx, listAt(ctx, args.list), id);
            const [fit] = await deps.explain(ctx.cv, [job], ctx.signal).catch(() => []);
            const matcher = new CvTextMatcher(ctx.cv.text);
            const years = paidYears(ctx);
            const matches = (fit?.have ?? []).filter((h) => h.quote && matcher.contains(h.quote));
            const missing = realGaps(fit?.missing ?? [], ctx.cv.text);
            return {
                title: job.title,
                company: job.company,
                location: job.location,
                salary: displaySalary(job.salary),
                url: job.url,
                ...(pastedJob ? { source: 'the advert the user pasted' } : {}),
                yearsOfPaidExperience: years ?? undefined,
                verdict: jobVerdict({ advert: job.description, have: matches.length, missing: missing.length, hardGap: hardGapIn(missing), years, tooSenior: Boolean(listed?.levelNote?.startsWith('May need')) }),
                // Only quotes really in the CV may be repeated to the user.
                matches,
                missing,
                summary: honestSummary(fit?.summary, jobVerdict({ advert: job.description, have: matches.length, missing: missing.length, hardGap: hardGapIn(missing), years, tooSenior: Boolean(listed?.levelNote?.startsWith('May need')) }).label),
                advert: (job.description ?? '').slice(0, 8000),
                instruction:
                    'Answer as a career adviser, about this one job. State its verdict plainly. Then use ui: a list "What matches" (each with a quote piece using the quotes given), a list "What the advert asks that your CV does not show", and steps for what to do next. Compare the level the advert asks for with their years. Use only this advert and their CV. Never promise they will get it.',
            };
        },
    });

    const detailsTool = defineTool({
        name: 'job_details',
        description: 'Reads one job from the latest job cards, by its position ("job 2") or id, to answer questions about it.',
        args: z.object({ position: z.number().int().min(1).max(50).optional(), list: z.number().int().min(0).max(2).optional(), id: z.number().int().positive().optional() }).strict(),
        label: () => 'Reading the job advert',
        maxResultChars: 9_000,
        async run(args, ctx) {
            const items = listAt(ctx, args.list)?.items ?? [];
            const showingList = listAt(ctx, args.list);
            const id = args.id ?? (args.position ? items[args.position - 1]?.id : undefined);
            if (!id) return { error: 'NO_SUCH_JOB', instruction: 'Say you cannot tell which job they mean, and ask them to pick one from the cards.' };
            const [job] = await deps.details([id], ctx.signal);
            if (!job) return { error: 'JOB_CLOSED', instruction: 'Say this job is no longer in the catalogue, so it may have closed.' };
            showJobCard(ctx, showingList, id);
            // A SOC or visa question gets the stored facts alone, so the answer cannot drift into describing the job.
            if (asksAboutSoc(ctx.userMessage ?? '')) {
                const visa = jobVisaFacts(job);
                const card = visa ? socFactsCard(visa.soc.code) : null;
                if (card) ctx.emit('official-facts', { kind: 'officialFacts', card });
                return {
                    title: job.title,
                    company: job.company,
                    visa: visa ? { soc: visa.soc, otherSoc: visa.otherSoc, outcome: visa.outcome, reasons: visa.reasons, newApplicants: visa.newApplicants, existingHolders: visa.existingHolders } : undefined,
                    instruction: visa
                        ? 'The official card shows every figure for this code; do not repeat figures. In words: name the likely code and any otherSoc, say it is CAFY\'s estimate and the employer chooses it, and say whether new applicants and existing visa holders can use it. If soc.sure is false say it is only a possible code. Never say this person will get a visa.'
                        : 'Say CAFY has no SOC or visa assessment for this job yet, and offer soc_lookup with the job title.',
                };
            }
            return {
                title: job.title,
                company: job.company,
                location: job.location,
                salary: displaySalary(job.salary),
                url: job.url,
                advert: (job.description ?? '').slice(0, 8000),
                instruction:
                    'The card shown with this answer has the Open advert link. Answer only what they asked: if they ask for the link, give the url above in your text in one line; if they ask the location, give the location. Give the full breakdown below only when they ask about the job in general. If they asked you to write something for this job, write it now, in full, in an example piece, from this advert and their CV, and leave out the breakdown below. If they ask the pay, give the salary above or say it is not stated, and give no other figure. Explain this job properly from the advert. Use ui: a list "What you would do", a list "What they ask for", and facts for location, salary and working pattern, saying "not stated in the advert" where it is missing. Use only what the advert says, never general text about the role. End by offering to compare it with their CV.',
            };
        },
    });

    return [searchTool, detailsTool, fitTool, recommendTool];
}

export const JOB_TOOLS: AgentTool[] = createJobTools();
