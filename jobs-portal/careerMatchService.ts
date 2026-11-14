import { createHash } from 'node:crypto';
import { z } from 'zod';
import { chatSearchSchema, type ChatSearch } from './chatIntent';
import { collectCareerCandidates, reloadCareerCandidates } from './careerMatchCatalogue';
import { careerProfileRoleQueries, conversationalSummary, extractCareerProfile, rankCareerJobs } from './careerMatchProfile';
import { collectCareerWebCandidates, reloadCareerWebCandidates, type CareerWebCollection } from './careerMatchWeb';
import { interpretCareerMatchConversation } from './careerMatchConversation';
import { ChatExecutionError, createChatExecution } from './chatExecution';
import {
    CAREER_CURSOR_MAX_LENGTH, careerCursorSecret, decryptCareerContext, decryptCareerCursor,
    encryptCareerContext, encryptCareerCursor, newCareerSnapshot, type CareerMatchSnapshot,
} from './careerMatchCursor';
import type {
    CareerFitStatus, CareerMatchCoverage, CareerMatchJob, CareerMatchResponse, CareerMatchState, CareerProfile,
    CareerWebDiscoveryStatus,
} from './careerMatchTypes';
import type { JobsPortalJob } from './types';
import { canonicalJobUrl } from './chatWebUrls';
import { ChatGoogleWebError, type ChatGroundedWeb } from './chatGoogleDiscovery';
import {
    CAREER_FIT_MIN_SCORE, CAREER_FIT_WINDOW, careerFitView, reverifiedCareerFit, type StoredCareerFit,
} from './careerMatchFit';

const startSchema = z.object({
    resumeText: z.string().trim().min(50).max(40_000),
    resumeName: z.string().trim().min(1).max(200).optional(),
    search: chatSearchSchema.optional(),
    message: z.string().trim().min(1).max(2000).optional(),
    includeWeb: z.boolean().optional(),
}).strict();
const nextSchema = z.object({ cursor: z.string().min(40).max(CAREER_CURSOR_MAX_LENGTH) }).strict();
const contextCursorSchema = z.string().min(40).max(CAREER_CURSOR_MAX_LENGTH);
const refineSchema = z.object({ contextCursor: contextCursorSchema, search: chatSearchSchema }).strict();
const conversationSchema = z.object({ contextCursor: contextCursorSchema, message: z.string().trim().min(1).max(2000) }).strict();
export const careerMatchInputSchema = z.union([startSchema, nextSchema, refineSchema, conversationSchema]);
export type CareerMatchInput = z.infer<typeof careerMatchInputSchema>;
export interface CareerMatchContext {
    userId: string;
    country: 'uk' | 'ireland';
    careerPremium: boolean;
    partTimePremium: boolean;
    partTimeBlocked: boolean;
}
export interface CareerMatchDependencies {
    extract?: typeof extractCareerProfile;
    collect?: typeof collectCareerCandidates;
    reload?: typeof reloadCareerCandidates;
    webCollect?: typeof collectCareerWebCandidates;
    webReload?: typeof reloadCareerWebCandidates;
    /**
     * Optional paid Google discovery. Receives occupation criteria plus equivalent titles,
     * career stage and a few skill names, never CV text, the summary or evidence.
     */
    groundedSearch?: (search: ChatSearch, country: CareerMatchContext['country'],
        options: { signal?: AbortSignal; timeoutMs: number; context?: CareerGroundedContext }) => Promise<ChatGroundedWeb>;
    /** Optional small AI call widening an explicit role into its equivalent titles, the role first. */
    expandRole?: (role: string, profile: CareerProfile,
        options: { signal?: AbortSignal; timeoutMs: number }) => Promise<string[]>;
    /** Optional paid fit judgement. Receives verified CV facts and adverts, never raw CV text. */
    assessFit?: (profile: CareerProfile, jobs: JobsPortalJob[],
        options: { signal?: AbortSignal; timeoutMs: number }) => Promise<Map<string, StoredCareerFit>>;
    cursorSecret?: string;
    now?: () => number;
    signal?: AbortSignal;
}
export interface CareerGroundedContext {
    roleTitles: string[];
    level?: CareerProfile['level'];
    skills: string[];
}
export class CareerMatchError extends Error {
    constructor(readonly code: 'PLAN_REQUIRED' | 'COUNTRY_CONFLICT' | 'UNSUPPORTED_FILTERS' | 'NOT_CONFIGURED' | 'CATALOGUE_UNAVAILABLE' | 'CANCELLED', message: string) {
        super(message);
    }
}

/** Bind continuation to the exact advert content that was actually ranked. */
export function careerJobFingerprint(job: JobsPortalJob): string {
    const ordered = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(ordered);
        if (value && typeof value === 'object')
            return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, ordered(item)]));
        return value;
    };
    // A later observation time is expected on a fresh source read. Substantive
    // advert facts (including posting/closing dates) remain bound to the shortlist.
    const listingSource = job.listingSource && Object.fromEntries(Object.entries(job.listingSource)
        .filter(([name]) => name !== 'retrievedAt'));
    return createHash('sha256').update(JSON.stringify(ordered({ ...job,
        ...(job.listingSource ? { listingSource } : {}), url: canonicalJobUrl(job.url) }))).digest('hex');
}

function assertAccess(search: ChatSearch, context: CareerMatchContext): void {
    const paid = search.kind === 'part-time' ? context.partTimePremium : context.careerPremium;
    if (!paid) throw new CareerMatchError('PLAN_REQUIRED', 'CV job matching requires the relevant paid jobs plan.');
    if ((search.kind === 'part-time' && (context.country !== 'uk' || context.partTimeBlocked)) ||
        (context.country === 'ireland' && (search.employerScope === 'civil-service' || search.sponsorship !== 'any')))
        throw new CareerMatchError('COUNTRY_CONFLICT', 'These filters are not supported by your saved catalogue country. Adjust the filters before matching.');
    if (search.unsupported.length)
        throw new CareerMatchError('UNSUPPORTED_FILTERS', 'Some active requirements cannot be verified. Remove the unsupported filters before matching your CV.');
}

function pageIdentity(snapshot: CareerMatchSnapshot, offset: number, state: CareerMatchState): string {
    return createHash('sha256').update(JSON.stringify([snapshot.subject, snapshot.issuedAt, snapshot.country,
        snapshot.profile, snapshot.search, snapshot.entries, offset, state])).digest('hex');
}
function publicMatch({ score: _score, ...match }: ReturnType<typeof rankCareerJobs>[number]): CareerMatchJob {
    return match;
}

const SNAPSHOT_BYTE_BUDGET = 88_000;

/** Match the ranker's canonical identity, including tracking, fragment and trailing-slash removal. */
function careerJobUrlHash(url: string): string | undefined {
    const safe = canonicalJobUrl(url);
    if (!safe) return undefined;
    const identity = new URL(safe);
    identity.hash = '';
    identity.pathname = identity.pathname.replace(/\/+$/, '') || '/';
    return createHash('sha256').update(identity.href).digest('hex');
}

function boundedSnapshot(snapshot: CareerMatchSnapshot, minimumEntries = 5): CareerMatchSnapshot {
    const bounded = { ...snapshot, entries: [...snapshot.entries], coverage: { ...snapshot.coverage } };
    while (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > SNAPSHOT_BYTE_BUDGET &&
        bounded.entries.length > minimumEntries) {
        bounded.entries.pop();
        bounded.coverage.limitReached = true;
    }
    return bounded;
}

function pendingNativeDiscovery(snapshot: CareerMatchSnapshot, explicitRetry = false): boolean {
    const failedRound = snapshot.coverage.web && snapshot.coverage.web.sourcesChecked > 0 &&
        snapshot.coverage.web.sourcesFailed >= snapshot.coverage.web.sourcesChecked;
    return snapshot.webEnabled !== false && (!snapshot.coverage.web || (explicitRetry && Boolean(failedRound))) &&
        snapshot.entries.length < 120 && snapshot.entries.every((entry) => Boolean(entry.urlHash)) &&
        Buffer.byteLength(JSON.stringify(snapshot), 'utf8') + 1024 <= SNAPSHOT_BYTE_BUDGET;
}
interface GroundedRound { status: CareerWebDiscoveryStatus; web?: ChatGroundedWeb }
type SnapshotEntry = CareerMatchSnapshot['entries'][number];
interface WindowItem { entry: SnapshotEntry; match: CareerMatchJob }

/** Keep scored-but-unshown judgements only while the token stays inside its byte budget. */
function fitBoundedSnapshot(snapshot: CareerMatchSnapshot, keep: number): CareerMatchSnapshot {
    const bounded = boundedSnapshot(snapshot, keep);
    if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= SNAPSHOT_BYTE_BUDGET) return bounded;
    return boundedSnapshot({ ...bounded, entries: bounded.entries.map(({ fit: _fit, ...entry }) => entry) }, keep);
}

/**
 * A match close to what the student asked for: ranking already requires the occupation
 * headline, so it also needs real CV overlap, or a good fit score once one is known.
 */
function alignedMatch(match: CareerMatchJob, profile: CareerProfile): boolean {
    return match.fit ? match.fit.score >= 55 : match.matchedSkills.length >= Math.min(2, profile.skills.length);
}

const listed = (items: string[]): string => items.length < 2 ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * Server-owned conversation copy built from the reviewed CV summary, returned adverts and source counts.
 * Phrasing varies by person and page without another AI call. It never lists what a CV lacks.
 */
function conversationMessage(snapshot: CareerMatchSnapshot, jobs: CareerMatchJob[], startOffset: number,
    state: CareerMatchState, hasMore: boolean, grounded?: GroundedRound, fitStatus?: CareerFitStatus): string {
    const seed = Number.parseInt(createHash('sha256')
        .update(JSON.stringify([snapshot.subject, snapshot.issuedAt, startOffset, state])).digest('hex').slice(0, 8), 16);
    const pick = <T>(options: T[]): T => options[seed % options.length];
    const { profile, search } = snapshot;
    const skills = listed(profile.skills.slice(0, 3).map((skill) => skill.name));
    const summary = conversationalSummary(profile);
    // Without a chosen role the CV's own directions were already searched.
    const family = new Set((snapshot.roleTitles || [search.role]).map((title) => title.toLowerCase()));
    const directions = search.role ? (profile.searchDirections || []).map((direction) => direction.title)
        .filter((title) => !family.has(title.toLowerCase())).slice(0, 2) : [];
    const nextStep = directions.length
        ? `From your CV, ${listed(directions)} could suit you too. Want me to look at one of those, or somewhere else?`
        : 'Tell me another role or location and I’ll search again, using the CV review I’ve already done.';
    const cards = grounded?.status === 'searched' ? grounded.web?.cards?.length || 0 : 0;
    const webLine = cards
        ? `I also went beyond our listings and searched Google: ${cards === 1 ? 'one more advert is' : `${cards} more adverts are`} below with Google’s sources. ${cards === 1 ? 'It isn’t' : 'They aren’t'} scored yet, so give the advert a quick read first.`
        : grounded?.status === 'searched' ? 'I searched Google too, but couldn’t confirm any extra individual adverts for this role.'
          : grounded?.status === 'unavailable' ? 'I tried Google as well, but that search didn’t come back this time.' : '';
    const join = (...parts: string[]) => parts.filter(Boolean).join(' ');
    if (state === 'needs-role') return join(
        `I’ve been through your whole CV${summary ? `. ${summary}` : ` and there’s clear evidence of ${skills}.`} What kind of role should I hunt for?`,
        'Add a city if you have one in mind. I’ll reuse the CV review I’ve just done.');
    if (state === 'needs-clarification')
        return 'Tell me which role or location you want to change. I’ll keep your CV review and the rest of your preferences.';
    if (state === 'unavailable') return join(
        'I couldn’t reach the job sources this time, so I couldn’t finish the search.', cards ? webLine : '',
        'Your CV review is still here for this session. Say “try again” and I’ll reuse it.');
    if (state === 'no-matches') return join(
        `I couldn’t find a close match for ${search.role || 'the roles your CV points to'}${search.where ? ` in ${search.where}` : ''} in our listings or on employer career pages right now.`,
        webLine, nextStep);
    if (state === 'exhausted') return join('That’s everything that suits you from this search.', webLine, nextStep);
    const top = jobs[0];
    const employer = top?.job.company?.trading_name || top?.job.company?.companies_house_name;
    const shared = listed(top?.matchedSkills.slice(0, 3) || []);
    const fit = top?.fit;
    const named = top ? `${top.job.title}${employer ? ` at ${employer}` : ''}` : '';
    const lead = pick(['My top pick is', 'Start with', 'The one I’d look at first is']);
    const topPick = !top ? ''
        : fit ? join(`${lead} ${named} (${fit.score}/100).`, fit.highlight || '')
          : shared ? `${lead} ${named}: ${shared} ${top.matchedSkills.length === 1 ? 'appears' : 'appear'} in both your CV and the advert.`
            : `${lead} ${named}.`;
    const fitLine = fitStatus === 'unavailable'
        ? 'I couldn’t finish the fit scoring this time, so these are ordered by how closely each role matches your CV.'
        : fitStatus ? 'Each card shows how well it suits you overall.' : '';
    const direct = jobs.filter(({ job }) => job.listingSource).length;
    const sources = direct
        ? `${direct} ${direct === 1 ? 'comes' : 'come'} straight from employer career pages or GOV.UK${jobs.length - direct ? `, and ${jobs.length - direct} from CAFY’s own listings` : ''}.`
        : '';
    const close = hasMore
        ? pick(['Want me to keep going? Tap “Show me five more”, or tell me what matters most, like a city, salary or remote work, and I’ll sharpen the search.',
            'Shall I find five more? Tap “Show me five more”, or give me a city, salary or working pattern to narrow it down.',
            'Tap “Show me five more” for the next set, or tell me what to change: a city, a salary, or a different role.'])
        : nextStep;
    if (startOffset > 0) {
        const counts = new Map<string, number>();
        jobs.flatMap((match) => match.matchedSkills).forEach((skill) => counts.set(skill, (counts.get(skill) || 0) + 1));
        const themes = [...counts].sort(([, left], [, right]) => right - left).slice(0, 2).map(([skill]) => skill);
        return join(
            jobs.length === 5
                ? pick(['Here are five more, all new.', 'Five more for you, nothing repeated.',
                    'Next five, picked from the same CV review.'])
                : `Let’s keep going. I found ${jobs.length === 1 ? 'one more role' : `${jobs.length} more roles`} that suit you.`,
            themes.length ? `This set leans on your ${listed(themes)}.` : '', topPick, sources,
            fitStatus === 'unavailable' ? fitLine : '', webLine, close);
    }
    const opening = summary
        ? `${pick(['I’ve read your whole CV.', 'Thanks, I’ve been through your whole CV.', 'I’ve had a proper read of your CV.'])} ${summary}`
        : `I’ve been through your whole CV, including the experience behind your ${skills}.`;
    const looked = `I searched CAFY’s jobs${snapshot.coverage.web?.sourcesChecked ? `, live employer career pages${snapshot.coverage.web.sourcesChecked > 1 ? ' and GOV.UK' : ''}` : ''}`;
    return join(opening,
        jobs.length === 5
            ? `${looked}, and these are the five that suit your background best.`
            : `${looked}, and found ${jobs.length === 1 ? 'one role' : `${jobs.length} roles`} that suit your background so far.`,
        topPick, sources, fitLine, webLine, close);
}

function response(snapshot: CareerMatchSnapshot, jobs: CareerMatchJob[], offset: number, startOffset: number,
    context: CareerMatchContext, secret: string, now: number, state: CareerMatchState,
    clarification?: string, conversationAction?: 'advice', grounded?: GroundedRound, fitStatus?: CareerFitStatus): CareerMatchResponse {
    const hasMore = state === 'results' && (offset < snapshot.entries.length || pendingNativeDiscovery(snapshot));
    const message = clarification || conversationMessage(snapshot, jobs, startOffset, state, hasMore, grounded, fitStatus);
    const current = { ...snapshot, offset, state };
    return {
        state, contextCursor: encryptCareerContext(current, context.userId, secret, now),
        ...(conversationAction ? { conversationAction } : {}),
        profile: current.profile, search: current.search, jobs, batchSize: 5, hasMore,
        pageId: pageIdentity(current, startOffset, state), coverage: current.coverage, message,
        ...(hasMore ? { nextCursor: encryptCareerCursor(current, context.userId, secret, now) } : {}),
        ...(grounded ? { groundedWebStatus: grounded.status, ...(grounded.web ? { groundedWeb: grounded.web } : {}) } : {}),
        ...(fitStatus && jobs.length ? { fitStatus } : {}),
    };
}

/** An explicit role searches its family of equivalent titles; otherwise the CV's own directions. */
function roleQueries(profile: CareerProfile, search: ChatSearch, roleTitles?: string[]): string[] {
    return search.role ? (roleTitles?.length ? roleTitles : [search.role]) : careerProfileRoleQueries(profile);
}

const TITLE_SHAPE = /^[^<>{}[\]@]{2,80}$/;
/** The family kept in the cursor: the student's own role first, then distinct well-formed titles. */
function storedFamily(role: string, titles: string[]): string[] | undefined {
    if (!role || !TITLE_SHAPE.test(role.trim())) return undefined;
    const family = [...new Map([role, ...titles].map((title) => title.trim())
        .filter((title) => TITLE_SHAPE.test(title)).map((title) => [title.toLowerCase(), title])).values()].slice(0, 8);
    return family.length > 1 ? family : undefined;
}
function sameRole(snapshot: CareerMatchSnapshot | undefined, search: ChatSearch): string[] | undefined {
    const titles = snapshot?.roleTitles;
    return search.role && titles?.[0]?.toLowerCase() === search.role.trim().toLowerCase() ? titles : undefined;
}

const emptyCoverage = (): CareerMatchCoverage => ({ catalogueScanned: 0, candidates: 0, limitReached: false, sourceFailures: 0 });

/** Request-scoped CV analysis and SELECT-only jobs. No billing, profile, tracker or history writes. */
export async function runCareerMatches(input: CareerMatchInput, context: CareerMatchContext,
    deps: CareerMatchDependencies = {}): Promise<CareerMatchResponse> {
    const assertActive = () => {
        if (deps.signal?.aborted) throw new CareerMatchError('CANCELLED', 'The matching request was cancelled.');
    };
    assertActive();
    const now = (deps.now || Date.now)();
    const startedAt = Date.now();
    const secret = deps.cursorSecret || careerCursorSecret();
    if (!secret || secret.length < 24)
        throw new CareerMatchError('NOT_CONFIGURED', 'CV job matching is not configured on this server yet.');
    const resumeSnapshot = (profile: CareerProfile, search: ChatSearch, entries: CareerMatchSnapshot['entries'],
        coverage: CareerMatchCoverage, original?: CareerMatchSnapshot, keep = 5, roleTitles?: string[]): CareerMatchSnapshot => {
        const family = roleTitles ?? sameRole(original, search);
        const created = newCareerSnapshot(context.userId, context.country, profile, search, entries, coverage, now);
        const snapshot = fitBoundedSnapshot(family ? { ...created, roleTitles: family } : created, keep);
        // URL lengths and Unicode evidence vary. Keep legal source references
        // inside the encrypted-token byte budget instead of failing an otherwise
        // valid first page as an expired cursor. Always retain the first five.
        // Refinements never extend the lifetime of the original paid analysis.
        return { ...snapshot, webEnabled: original?.webEnabled ?? ('includeWeb' in input ? input.includeWeb !== false : true),
            ...(original ? { issuedAt: original.issuedAt, expiresAt: original.expiresAt } : {}) };
    };
    const sourceFailure = (snapshot: CareerMatchSnapshot, offset: number, grounded?: GroundedRound): CareerMatchResponse => {
        assertActive();
        const unavailable = { ...snapshot, coverage: { ...snapshot.coverage,
            sourceFailures: Math.min(10, Math.max(1, snapshot.coverage.sourceFailures)) } };
        return response(unavailable, [], offset, offset, context, secret, now, 'unavailable', undefined, undefined, grounded);
    };
    const propagateCancellation = (error: unknown): void => {
        assertActive();
        if (error instanceof ChatExecutionError || (error instanceof Error && error.name === 'AbortError')) throw error;
    };
    // At most one Google round per CV search, and only when CAFY lacks five aligned
    // adverts for the request. It needs both of its phases, so a nearly spent budget skips it and
    // leaves the round available to a later page of the same search.
    const groundedLookup = async (search: ChatSearch, profile: CareerProfile, webEnabled: boolean | undefined,
        remainingMs: number, roleTitles?: string[]): Promise<GroundedRound | undefined> => {
        const titles = roleQueries(profile, search, roleTitles);
        const role = search.role || titles[0];
        if (!deps.groundedSearch || webEnabled === false || !role) return undefined;
        if (search.unsupported.length || search.sponsorship !== 'any') return { status: 'skipped' };
        const timeoutMs = Math.min(30_000, remainingMs - 1500);
        if (timeoutMs < 12_000) return undefined;
        try {
            // Titles, career stage and a few skill names only: never the summary, quotes or anything identifying.
            const searchContext: CareerGroundedContext = { roleTitles: titles.slice(0, 6),
                ...(profile.level ? { level: profile.level } : {}),
                skills: profile.skills.slice(0, 4).map((skill) => skill.name) };
            const web = await deps.groundedSearch({ ...search, role }, context.country,
                { signal: deps.signal, timeoutMs, context: searchContext });
            assertActive();
            return web.format === 'job-cards' && Array.isArray(web.cards) ? { status: 'searched', web } : { status: 'unavailable' };
        } catch (error) {
            propagateCancellation(error);
            return { status: error instanceof ChatGoogleWebError && error.code === 'UNSUPPORTED' ? 'skipped' : 'unavailable' };
        }
    };
    /** Keep each advert in one place: a supported CV match outranks its Google duplicate. */
    const distinctGrounded = (grounded: GroundedRound | undefined, entries: CareerMatchSnapshot['entries']) => {
        if (!grounded?.web?.cards) return grounded;
        const known = new Set(entries.map((entry) => entry.urlHash));
        return { ...grounded, web: { ...grounded.web, cards: grounded.web.cards.filter((card) => {
            const hash = careerJobUrlHash(card.url);
            return !hash || !known.has(hash);
        }) } };
    };
    /**
     * Judge the unscored adverts in a page window once, reuse stored judgements from
     * the cursor (the entry fingerprint already binds the advert), and order the window
     * by the server-computed fit score. Unscored adverts keep their evidence order after
     * scored ones; adverts scored below the floor are set aside, never shown.
     */
    const scoreWindow = async (profile: CareerProfile, window: WindowItem[], remainingMs: number):
        Promise<{ items: WindowItem[]; below: SnapshotEntry[]; status?: CareerFitStatus }> => {
        if (!deps.assessFit || !window.length) return { items: window, below: [] };
        const reused = new Map<string, StoredCareerFit>();
        for (const { entry } of window) {
            const fit = entry.fit && reverifiedCareerFit(entry.fit);
            if (fit) reused.set(entry.id, fit);
        }
        const pending = window.filter(({ entry }) => !reused.has(entry.id)).map(({ match }) => match.job);
        let fresh = new Map<string, StoredCareerFit>();
        const timeoutMs = Math.min(20_000, remainingMs - 1500);
        if (pending.length && timeoutMs >= 6000) {
            try {
                fresh = await deps.assessFit(profile, pending, { signal: deps.signal, timeoutMs });
            } catch (error) { propagateCancellation(error); }
            assertActive();
        }
        const items = window.map(({ entry: { fit: _previous, ...entry }, match }, index) => {
            const stored = reused.get(entry.id) ?? fresh.get(match.job.id);
            return { index, item: stored ? { entry: { ...entry, fit: stored }, match: { ...match, fit: careerFitView(stored) } }
                : { entry, match } };
        });
        items.sort((left, right) => (right.item.match.fit?.score ?? -1) - (left.item.match.fit?.score ?? -1) || left.index - right.index);
        const low = (item: WindowItem) => Boolean(item.match.fit && item.match.fit.score < CAREER_FIT_MIN_SCORE);
        const ordered: WindowItem[] = items.map(({ item }) => item);
        const kept = ordered.filter((item) => !low(item));
        const below = ordered.filter(low).map(({ entry: { fit: _fit, ...entry } }) => entry);
        const shown = kept.slice(0, 5).filter((item) => item.match.fit).length;
        const scoredAny = items.some(({ item }) => item.match.fit);
        return { items: kept, below,
            status: !scoredAny ? 'unavailable' : shown === Math.min(5, kept.length) ? 'scored' : 'partial' };
    };
    const nextPage = async (snapshot: CareerMatchSnapshot, retryNativeDiscovery = false): Promise<CareerMatchResponse> => {
        assertAccess(snapshot.search, context);
        const execution = createChatExecution({ signal: deps.signal,
            timeoutMs: Math.max(0, 50_000 - (Date.now() - startedAt)) });
        try {
            const startOffset = snapshot.offset;
            const remaining = snapshot.entries.slice(startOffset);
            // With fit scoring, the best five are chosen from a window of up to ten.
            const target = deps.assessFit ? CAREER_FIT_WINDOW : 5;
            const dropped: SnapshotEntry[] = [];
            const window: WindowItem[] = [];
            let scanned = 0;
            let failures = 0;
            // Re-read exact native sources, never repeat the CV provider call or
            // restart discovery. Failed sources remain retryable without hiding
            // successfully revalidated jobs from an independent source.
            while (window.length < target && scanned < remaining.length) {
                assertActive();
                const remainingMs = execution.remainingMs();
                // Preserve completed matches and leave unread entries for another
                // request rather than losing them at the parent route deadline.
                if (remainingMs < 1000) {
                    if (!window.length) return sourceFailure(snapshot, startOffset);
                    break;
                }
                const chunk = remaining.slice(scanned, scanned + 20);
                const catalogue = chunk.filter((entry) => !entry.webReference);
                const external = chunk.filter((entry) => entry.webReference);
                const results = await Promise.allSettled([
                    catalogue.length ? execution.run(() => (deps.reload || reloadCareerCandidates)(
                        catalogue.map((entry) => entry.id), snapshot.search, snapshot.country,
                        { signal: execution.signal, roleTitles: snapshot.roleTitles },
                    )) : Promise.resolve([] as JobsPortalJob[]),
                    external.length ? execution.run(() => (deps.webReload || reloadCareerWebCandidates)(
                        external.map((entry) => entry.webReference!), snapshot.search, snapshot.country,
                        { signal: execution.signal, timeoutMs: Math.min(20_000, Math.max(1, remainingMs - 500)),
                            roleTitles: snapshot.roleTitles },
                    )) : Promise.resolve({ jobs: [] as JobsPortalJob[], sourceFailures: 0 }),
                ]);
                assertActive();
                const current: JobsPortalJob[] = [];
                const failed = new Set<string>();
                results.forEach((result, index) => {
                    const entries = index === 0 ? catalogue : external;
                    if (result.status === 'rejected') {
                        if (!execution.signal.aborted) propagateCancellation(result.reason);
                        failures++;
                        entries.forEach((entry) => failed.add(entry.id));
                    } else if (Array.isArray(result.value)) current.push(...result.value);
                    else {
                        current.push(...result.value.jobs);
                        if (result.value.sourceFailures) {
                            failures += result.value.sourceFailures;
                            const delivered = new Set(result.value.jobs.map((job) => job.id));
                            entries.filter((entry) => !delivered.has(entry.id)).forEach((entry) => failed.add(entry.id));
                        }
                    }
                });
                const byId = new Map(current.map((job) => [job.id, job]));
                const stable = chunk.flatMap((entry) => {
                    const job = byId.get(entry.id);
                    return job && careerJobFingerprint(job) === entry.fingerprint ? [job] : [];
                });
                const ranked = new Map(rankCareerJobs(snapshot.profile, stable, snapshot.search, snapshot.roleTitles)
                    .map((match) => [match.job.id, match]));
                for (const entry of chunk) {
                    scanned++;
                    // Failed entries stay unread in place; unsupported ones are passed over.
                    if (!failed.has(entry.id)) {
                        const match = ranked.get(entry.id);
                        if (match) window.push({ entry, match: publicMatch(match) });
                        else dropped.push(entry);
                    }
                    if (window.length === target) break;
                }
            }
            if (!window.length && failures) return sourceFailure(snapshot, startOffset);
            let updated = { ...snapshot,
                coverage: { ...snapshot.coverage, sourceFailures: Math.min(10, snapshot.coverage.sourceFailures + failures) } };
            /** History, passed-over entries, shown jobs, scored leftovers, then everything still unread. */
            const arrange = (base: CareerMatchSnapshot, shown: SnapshotEntry[], kept: SnapshotEntry[]) => {
                const moved = new Set([...dropped, ...shown, ...kept].map((entry) => entry.id));
                return { snapshot: { ...base, entries: [...base.entries.slice(0, startOffset), ...dropped, ...shown, ...kept,
                    ...base.entries.slice(startOffset).filter((entry) => !moved.has(entry.id))] },
                offset: startOffset + dropped.length + shown.length };
            };
            // A deep catalogue may have deferred discovery initially. Before
            // declaring its tail exhausted, check independent native sources
            // once, using the same CV and the remaining shared request budget.
            if (window.length < 5 && scanned === remaining.length && !failures &&
                pendingNativeDiscovery(updated, retryNativeDiscovery)) {
                const remainingMs = execution.remainingMs();
                if (remainingMs < 1000) {
                    if (!window.length) {
                        const empty = arrange(updated, [], []);
                        return sourceFailure(empty.snapshot, empty.offset);
                    }
                } else {
                    let web: CareerWebCollection;
                    try {
                        web = await execution.run(() => (deps.webCollect || collectCareerWebCandidates)(
                            snapshot.search, snapshot.country, roleQueries(snapshot.profile, snapshot.search, snapshot.roleTitles),
                            { signal: execution.signal, timeoutMs: Math.min(20_000, remainingMs - 500) },
                        ));
                    } catch (error) {
                        assertActive();
                        if (!execution.signal.aborted) propagateCancellation(error);
                        const count = snapshot.country === 'uk' ? 2 : 1;
                        web = { jobs: [], references: {}, coverage: { examined: 0, candidates: 0,
                            sourcesChecked: count, sourcesFailed: count, sourcesAvailable: count, limitReached: true } };
                    }
                    assertActive();
                    const seenIds = new Set(updated.entries.map((entry) => entry.id));
                    const seenUrls = new Set(updated.entries.map((entry) => entry.urlHash));
                    const externalCount = updated.entries.filter((entry) => entry.webReference).length;
                    const slots = Math.min(40 - externalCount, 120 - updated.entries.length);
                    const candidates = web.jobs.filter((job) => {
                        const hash = careerJobUrlHash(job.url);
                        return Boolean(job.listingSource && web.references[job.id] && hash &&
                            !seenIds.has(job.id) && !seenUrls.has(hash));
                    });
                    const additions = rankCareerJobs(snapshot.profile, candidates, snapshot.search, snapshot.roleTitles).slice(0, slots);
                    const oldLength = updated.entries.length;
                    updated = boundedSnapshot({ ...updated,
                        entries: [...updated.entries, ...additions.map(({ job }) => ({
                            id: job.id, fingerprint: careerJobFingerprint(job), urlHash: careerJobUrlHash(job.url),
                            webReference: web.references[job.id]!,
                        }))],
                        coverage: { ...updated.coverage, web: web.coverage,
                            sourceFailures: Math.min(10, updated.coverage.sourceFailures + web.coverage.sourcesFailed),
                            limitReached: updated.coverage.limitReached || web.coverage.limitReached || additions.length < candidates.length },
                    }, oldLength);
                    const retained = new Map(updated.entries.slice(oldLength).map((entry) => [entry.id, entry]));
                    additions.filter((match) => retained.has(match.job.id)).slice(0, target - window.length)
                        .forEach((match) => window.push({ entry: retained.get(match.job.id)!, match: publicMatch(match) }));
                }
            }
            if (!window.length && updated.coverage.web && updated.coverage.web.sourcesChecked > 0 &&
                updated.coverage.web.sourcesFailed >= updated.coverage.web.sourcesChecked) {
                const empty = arrange(updated, [], []);
                return sourceFailure(empty.snapshot, empty.offset);
            }
            const scored = await scoreWindow(updated.profile, window, execution.remainingMs());
            // Low-scored adverts are passed over like unsupported ones.
            dropped.push(...scored.below);
            const shown = scored.items.slice(0, 5);
            const placed = arrange(updated, shown.map(({ entry: { fit: _fit, ...entry } }) => entry),
                scored.items.slice(5).map(({ entry }) => entry));
            const offset = placed.offset;
            updated = fitBoundedSnapshot(placed.snapshot, offset + scored.items.length - shown.length);
            const pageFit = shown.length ? scored.status : undefined;
            const jobs = shown.map(({ match }) => match);
            // CAFY has no five more aligned jobs for this request: look once on the web too.
            let grounded: GroundedRound | undefined;
            if (jobs.filter((match) => alignedMatch(match, updated.profile)).length < 5 && !updated.groundedChecked &&
                !pendingNativeDiscovery(updated)) {
                grounded = distinctGrounded(await groundedLookup(updated.search, updated.profile, updated.webEnabled,
                    execution.remainingMs(), updated.roleTitles), updated.entries);
                if (grounded) updated = { ...updated, groundedChecked: true };
            }
            return response(updated, jobs, offset, startOffset, context, secret, now,
                jobs.length ? 'results' : 'exhausted', undefined, undefined, grounded, pageFit);
        } finally { execution.cleanup(); }
    };
    if ('cursor' in input) {
        const snapshot = decryptCareerCursor(input.cursor, context.userId, context.country, secret, now);
        return nextPage(snapshot);
    }
    const remembered = 'contextCursor' in input
        ? decryptCareerContext(input.contextCursor, context.userId, context.country, secret, now) : undefined;
    let search = chatSearchSchema.parse('search' in input && input.search
        ? input.search : remembered?.search || { role: '', where: '', kind: 'career' });
    assertAccess(remembered && 'message' in input ? { ...search, unsupported: [] } : search, context);
    const profile: CareerProfile = remembered?.profile ?? await (deps.extract || extractCareerProfile)(
        'resumeText' in input ? input.resumeText : '', { signal: deps.signal });
    assertActive();
    if ('message' in input && input.message) {
        const turn = interpretCareerMatchConversation(input.message, search, { needsRole: !roleQueries(profile, search).length });
        search = turn.search ?? search;
        if (turn.action === 'more' && remembered) {
            if (remembered.entries.length) return nextPage(remembered);
            const state = remembered.state === 'unavailable' ? 'unavailable'
                : !roleQueries(profile, search).length ? 'needs-role'
                  : remembered.state === 'needs-clarification' ? 'needs-clarification' : 'no-matches';
            return response(remembered, [], remembered.offset, remembered.offset, context, secret, now, state);
        }
        if (turn.action === 'retry' && remembered?.state === 'unavailable' && remembered.entries.length)
            return nextPage(remembered, true);
        const retrySearch = turn.action === 'retry' && remembered?.state === 'unavailable';
        if (turn.action !== 'search' && !retrySearch) {
            // Pending unsupported filters may be retained for clarification;
            // premium and country checks still apply, and no SQL runs.
            assertAccess({ ...search, unsupported: [] }, context);
            const sameSearch = remembered && JSON.stringify(remembered.search) === JSON.stringify(search);
            const snapshot = sameSearch ? remembered
                : resumeSnapshot(profile, search, [], emptyCoverage(), remembered);
            const state = turn.action === 'advice' ? 'needs-clarification'
                : !roleQueries(profile, search).length ? 'needs-role' : 'needs-clarification';
            return response(snapshot, [], snapshot.offset, snapshot.offset, context, secret, now, state,
                turn.message || (turn.action === 'advice'
                    ? 'Let’s work through that career question.'
                    : turn.action === 'retry'
                      ? 'Your CV analysis is still available. Tell me which role, location or preference to change, or ask for the next five from your current shortlist.' : undefined),
                turn.action === 'advice' ? 'advice' : undefined);
        }
    }
    assertAccess(search, context);
    if (!roleQueries(profile, search).length) {
        const snapshot = resumeSnapshot(profile, search, [], emptyCoverage(), remembered);
        return response(snapshot, [], 0, 0, context, secret, now, 'needs-role');
    }
    // "Developer" also means Software Engineer, Programmer and the like. One small, bounded
    // call per new explicit role; the family is reused from the cursor for the same role.
    let roleTitles = sameRole(remembered, search);
    if (search.role && !roleTitles && deps.expandRole) {
        try {
            roleTitles = storedFamily(search.role, await deps.expandRole(search.role, profile, { signal: deps.signal, timeoutMs: 6000 }));
        } catch (error) { propagateCancellation(error); }
        assertActive();
    }
    const queries = roleQueries(profile, search, roleTitles);
    const collectCatalogue = async (): Promise<Awaited<ReturnType<typeof collectCareerCandidates>>> => {
        try {
            return await (deps.collect || collectCareerCandidates)(search, context.country, queries, { signal: deps.signal });
        } catch (error) {
            propagateCancellation(error);
            return { jobs: [], coverage: { ...emptyCoverage(), sourceFailures: 1 } };
        }
    };
    const webEnabled = remembered?.webEnabled ?? ('includeWeb' in input ? input.includeWeb !== false : true);
    const nativeRound = async (): Promise<CareerWebCollection | undefined> => {
        if (!webEnabled) return undefined;
        // Employer and government sites are searched beside the catalogue on every
        // search. The cap leaves room for fit scoring under the route's 55s budget.
        const timeoutMs = Math.min(16_000, Math.max(0, 50_000 - (Date.now() - startedAt)));
        if (timeoutMs < 500) return { jobs: [], references: {}, coverage: { examined: 0, candidates: 0, sourcesChecked: 0,
            sourcesFailed: 0, sourcesAvailable: context.country === 'uk' ? 2 : 1, limitReached: true } };
        try {
            return await (deps.webCollect || collectCareerWebCandidates)(search, context.country, queries,
                { signal: deps.signal, timeoutMs });
        } catch (error) {
            propagateCancellation(error);
            return { jobs: [], references: {}, coverage: { examined: 0, candidates: 0,
                sourcesChecked: context.country === 'uk' ? 2 : 1, sourcesFailed: context.country === 'uk' ? 2 : 1,
                sourcesAvailable: context.country === 'uk' ? 2 : 1, limitReached: true } };
        }
    };
    const catalogueTask = collectCatalogue();
    // Google starts as soon as the catalogue proves to lack five aligned adverts, beside
    // the native sources and fit scoring, so it still fits the route deadline. Its cards are never CV-ranked.
    const groundedTask = catalogueTask.then((found) => rankCareerJobs(profile, found.jobs, search, roleTitles)
        .filter((match) => alignedMatch(match, profile)).length < 5
        ? groundedLookup(search, profile, webEnabled, 50_000 - (Date.now() - startedAt), roleTitles) : undefined);
    groundedTask.catch(() => undefined);
    const [found, web] = await Promise.all([catalogueTask, nativeRound()]);
    assertActive();
    const catalogueStatus = found.coverage.sourceFailures && !found.jobs.length ? 'unavailable' : 'checked';
    const coverage: CareerMatchCoverage = { ...found.coverage, catalogueStatus,
        sourceFailures: Math.min(10, found.coverage.sourceFailures + (web?.coverage.sourcesFailed || 0)),
        limitReached: found.coverage.limitReached || Boolean(web?.coverage.limitReached),
        ...(web ? { web: web.coverage } : {}) };
    // Only independently retrieved adverts with native continuation references
    // enter the ranked pool. Google cards stay a separate, transient section.
    const catalogueIds = new Set(found.jobs.map((job) => job.id));
    const external = (web?.jobs || []).filter((job) => !catalogueIds.has(job.id) && Boolean(web?.references[job.id]));
    let webCount = 0;
    const ranked = rankCareerJobs(profile, [...found.jobs, ...external], search, roleTitles).filter(({ job }) => {
        if (!job.listingSource) return catalogueIds.has(job.id);
        return Boolean(web?.references[job.id]) && ++webCount <= 40;
    }).slice(0, 120);
    const entryFor = (job: JobsPortalJob): SnapshotEntry => ({ id: job.id, fingerprint: careerJobFingerprint(job),
        urlHash: careerJobUrlHash(job.url),
        ...(job.listingSource && web?.references[job.id] ? { webReference: web.references[job.id] } : {}) });
    const window = ranked.slice(0, deps.assessFit ? CAREER_FIT_WINDOW : 5).map((match) => ({ entry: entryFor(match.job), match: publicMatch(match) }));
    const scored = await scoreWindow(profile, window, 50_000 - (Date.now() - startedAt));
    const groundedFound = await groundedTask;
    assertActive();
    const shown = scored.items.slice(0, 5);
    const kept = scored.items.slice(5).map(({ entry }) => entry);
    // Set-aside low scores sit with the history, before the shown page, so "more" never returns them.
    const ranking = resumeSnapshot(profile, search, [...scored.below, ...shown.map(({ entry: { fit: _fit, ...entry } }) => entry), ...kept,
        ...ranked.slice(window.length).map(({ job }) => entryFor(job))], coverage, remembered,
        scored.below.length + shown.length + kept.length, roleTitles);
    const snapshot = groundedFound ? { ...ranking, groundedChecked: true } : ranking;
    const grounded = distinctGrounded(groundedFound, snapshot.entries);
    if (!ranked.length && catalogueStatus === 'unavailable' && (!web || web.coverage.sourcesFailed >= web.coverage.sourcesChecked))
        return sourceFailure(snapshot, 0, grounded);
    return response(snapshot, shown.map(({ match }) => match), scored.below.length + shown.length, 0, context, secret, now,
        shown.length ? 'results' : 'no-matches', undefined, undefined, grounded, shown.length ? scored.status : undefined);
}
