import { applyJobsPortalEntitlements, type JobsFeedResult, type JobsPortalAccessMeta } from './entitlements';
import { FREE_BROWSE_JOBS_LIMIT, FREE_SEARCH_JOBS_LIMIT, JOBS_PAGE_SIZE } from './constants';
import { officialPartTimeCity } from './partTimeCities';
import { toPublicPortalJobs } from './publicResponse';
import {
    chatSearchSchema,
    interpretJobChatRules,
    normalizeInterpretedChatIntent,
    type ChatSearch,
    type JobChatInput,
    type modelChatIntentSchema,
} from './chatIntent';
import type { z } from 'zod';
import type { JobsPortalJob } from './types';
import { matchChatJob } from './chatMatching';
import { mergeChatJobSources, webRequestFromMessage } from './chatWebMerge';
import { ChatGoogleWebError, type ChatGroundedWeb } from './chatGoogleDiscovery';
import { answerChatCareerQuestion, type CareerGuidance, type CareerKnowledgeDependencies } from './chatKnowledge';
import { reviewJobChatMessage } from './chatPolicy';
import { ChatExecutionError } from './chatExecution';

export interface ChatWebStatus {
    requested: boolean;
    provider: 'employer-sites';
    status: 'not_requested' | 'disabled' | 'premium_required' | 'searched' | 'unavailable' | 'skipped';
    examined: number;
    matched: number;
    returned: number;
    excluded: number;
    retrievedAt?: string;
    cacheHit?: boolean;
    boardsChecked?: number;
    boardsFailed?: number;
    boardsAvailable?: number;
    limitReached?: boolean;
    exhaustive: false;
}

export interface JobChatContext {
    catalogCountry: 'uk' | 'ireland';
    careerPremium: boolean;
    partTimePremium: boolean;
    partTimeBlocked: boolean;
}

export interface ChatCatalogueResult extends JobsFeedResult {
    /** Counts cover the examined candidates only when limitReached is true. */
    coverage?: { scanned: number; limitReached: boolean };
    evidence?: Record<string, string[]>;
}

export interface JobChatResponse {
    catalogueStatus?: 'searched' | 'unavailable' | 'skipped';
    mode?: 'search' | 'advice' | 'clarification' | 'refusal';
    guidance?: CareerGuidance;
    web?: ChatWebStatus;
    /** Display-only Google research; never merge into job records, history or counts. */
    groundedWeb?: ChatGroundedWeb;
    groundedWebStatus?: 'not_requested' | 'searched' | 'unavailable' | 'skipped' | 'premium_required';
    message: string;
    search: ChatSearch;
    jobs: JobsPortalJob[];
    totalCount: number;
    access?: JobsPortalAccessMeta;
    coverage?: ChatCatalogueResult['coverage'];
    evidence: Record<string, string[]>;
    suggestions: string[];
    interpretation: 'ai' | 'rules';
}

export interface JobChatDependencies {
    selectGuidance?: CareerKnowledgeDependencies['select'];
    /** Deterministic test clock; production uses the real review-expiry clock. */
    guidanceNow?: () => number;
    groundedSearch?: (search: ChatSearch, country: JobChatContext['catalogCountry']) => Promise<ChatGroundedWeb>;
    webFeed?: (
        search: ChatSearch,
        country: JobChatContext['catalogCountry'],
    ) => Promise<{
        jobs: JobsPortalJob[];
        examined: number;
        excluded: number;
        retrievedAt: string;
        cacheHit: boolean;
        boardsChecked?: number;
        boardsFailed?: number;
        boardsAvailable?: number;
        limitReached?: boolean;
    }>;
    enrichWebJobs?: (jobs: JobsPortalJob[]) => Promise<JobsPortalJob[]>;
    careerFeed: (search: ChatSearch, maxJobsReturned?: number) => Promise<ChatCatalogueResult>;
    partTimeFeed: (search: ChatSearch, maxJobsReturned?: number) => Promise<ChatCatalogueResult>;
    interpret?: (input: JobChatInput, baseline: ChatSearch) => Promise<z.infer<typeof modelChatIntentSchema> | null>;
    hydrateJobs?: (
        search: ChatSearch,
        jobs: JobsPortalJob[],
    ) => Promise<Array<{ id: string; description?: string | null }>>;
}

export class JobChatAccessError extends Error {
    readonly code = 'PART_TIME_UK_ONLY';
    readonly status = 403;
    constructor() {
        super('Part-time jobs are available for United Kingdom profiles.');
    }
}

export function hasChatCriteria(search: ChatSearch): boolean {
    return Boolean(
        search.role ||
        search.employerScope !== 'any' ||
        search.where ||
        search.employer ||
        search.jobTypes.length ||
        search.levels.length ||
        search.workingArrangement !== 'any' ||
        search.salary ||
        search.sponsorship !== 'any',
    );
}

function suggestions(search: ChatSearch): string[] {
    const refinements = [
        ...(search.unsupported.length ? ['Remove unsupported filters'] : []),
        ...(search.salary ? ['Any salary'] : []),
        ...(search.workingArrangement !== 'any' ? ['Any working arrangement'] : []),
        ...(search.employer ? ['Any employer'] : []),
        ...(search.employerScope === 'civil-service' ? ['No Civil Service filter'] : []),
        ...(search.where ? ['Any location'] : []),
        ...(search.levels.length ? ['Any experience level'] : []),
        ...(search.jobTypes.length ? ['Any job type'] : []),
        ...(search.sponsorship !== 'any' ? ['No sponsorship filter'] : []),
    ];
    // Refinements describe this search; no unrelated cities or occupations are invented.
    return [...refinements.slice(0, 3), 'Start over'];
}

function requestedCountry(message: string): JobChatContext['catalogCountry'] | undefined {
    const country =
        /\b(?:in|across|throughout|within)\s+(?:the\s+)?(united kingdom|uk|britain|england|scotland|wales|northern ireland|republic of ireland|ireland)\b/i.exec(
            message,
        )?.[1] ||
        /\b(united kingdom|uk|british|irish|ireland)\s+(?:career\s+)?(?:jobs?|roles?|vacancies)\b/i.exec(message)?.[1];
    if (!country) return undefined;
    return /^(?:republic of ireland|ireland|irish)$/i.test(country) ? 'ireland' : 'uk';
}

export async function runJobChat(
    input: JobChatInput,
    context: JobChatContext,
    deps: JobChatDependencies,
): Promise<JobChatResponse> {
    // Check raw text before whitespace/source normalization, so a newline cannot
    // hide a second instruction. Rebuild safe user history in chronological order.
    const originalPolicy = reviewJobChatMessage(input.message, {
        previousSearch: input.search,
        history: input.history,
    });
    const safeHistory: JobChatInput['history'] = [];
    const searchHistory: JobChatInput['history'] = [];
    let historicalSearch: ChatSearch | undefined;
    for (const item of input.history) {
        if (item.role !== 'user') continue;
        const decision = reviewJobChatMessage(item.content, {
            previousSearch: historicalSearch,
            history: safeHistory,
        });
        if (!['career-search', 'career-advice'].includes(decision.decision)) continue;
        const safeItem = { ...item, content: webRequestFromMessage(item.content).message };
        safeHistory.push(safeItem);
        if (decision.decision === 'career-search') {
            searchHistory.push(safeItem);
            historicalSearch = interpretJobChatRules({
                message: safeItem.content,
                history: [],
                search: historicalSearch,
            }).search;
        }
    }
    const sourceRequest = webRequestFromMessage(input.message, input.includeWeb);
    input = {
        ...input,
        message: sourceRequest.message,
        history: safeHistory,
    };
    const web: ChatWebStatus = {
        requested: sourceRequest.requested,
        provider: 'employer-sites',
        status: sourceRequest.requested ? 'skipped' : 'not_requested',
        examined: 0,
        matched: 0,
        returned: 0,
        excluded: 0,
        exhaustive: false,
    };
    const policy =
        originalPolicy.decision === 'blocked'
            ? originalPolicy
            : reviewJobChatMessage(input.message, { previousSearch: input.search, history: safeHistory });
    const preservedSearch = input.search || chatSearchSchema.parse({ role: '', where: '', kind: 'career' });
    const localReply = (mode: 'clarification' | 'refusal', message: string): JobChatResponse => ({
        mode,
        catalogueStatus: 'skipped',
        message,
        search: preservedSearch,
        jobs: [],
        totalCount: 0,
        evidence: {},
        suggestions: ['Help me improve my CV', 'How do I prepare for an interview?', 'Start over'],
        interpretation: 'rules',
        web,
        groundedWebStatus: web.requested ? 'skipped' : 'not_requested',
    });
    // Reject before model calls or catalogue/employer reads. Client-supplied prior
    // criteria are untrusted too, even if a short follow-up itself looks harmless.
    const priorFields = input.search
        ? [input.search.role, input.search.where, input.search.employer, ...input.search.unsupported]
        : [];
    if (
        policy.decision === 'blocked' ||
        priorFields.some((field) => reviewJobChatMessage(field).decision === 'blocked')
    )
        return localReply(
            'refusal',
            policy.message ||
                'I can help with genuine career and job-search questions. Please ask about jobs, CVs, applications or interviews.',
        );
    if (policy.decision === 'clarify') return localReply('clarification', policy.message);

    // Never trust supplied assistant history as system instructions. Prior user
    // messages that are unrelated or attempt an override do not enter an AI prompt.
    if (policy.decision === 'career-advice') {
        const canSelect = preservedSearch.kind === 'part-time' ? context.partTimePremium : context.careerPremium;
        const answer = await answerChatCareerQuestion({ ...input, history: safeHistory }, context.catalogCountry, {
            select: canSelect ? deps.selectGuidance : undefined,
            now: deps.guidanceNow,
        });
        return { ...localReply('clarification', answer.message), ...answer };
    }
    input = { ...input, history: searchHistory };
    const baseline = interpretJobChatRules(input);
    let search = baseline.search;
    let clarification = baseline.clarification;
    let interpretation: JobChatResponse['interpretation'] = 'rules';
    const targetCountry = requestedCountry(input.message);
    const countryConflict = targetCountry && targetCountry !== context.catalogCountry;
    if (search.kind === 'part-time' && context.partTimeBlocked) throw new JobChatAccessError();

    const canUseAi = search.kind === 'part-time' ? context.partTimePremium : context.careerPremium;
    const explicitRemoval =
        /^(?:any (?:salary|location|employer|experience level|job type|working arrangement)|no sponsorship filter|no civil service filter|remove unsupported filters)[.!]?$/i.test(
            input.message.trim(),
        );
    if (canUseAi && deps.interpret && !baseline.requiresClarification && !countryConflict && !explicitRemoval) {
        // Provider errors must not turn an otherwise valid deterministic query into invented results.
        const proposed = await deps.interpret(input, search).catch(() => null);
        const intent = proposed ? normalizeInterpretedChatIntent(proposed, input, baseline) : null;
        if (intent) {
            const { needsClarification, clarification: entityClarification, ...fields } = intent;
            search = chatSearchSchema.parse(fields);
            clarification = needsClarification
                ? entityClarification ||
                  'What job title or type of work should I search? You can also name an employer or location.'
                : undefined;
            interpretation = 'ai';
        }
    }

    if (search.kind === 'part-time' && context.partTimeBlocked) throw new JobChatAccessError();
    if (search.kind === 'part-time' && search.where && !officialPartTimeCity(search.where)) {
        clarification =
            'For part-time jobs, choose a supported UK city such as London, Manchester, Birmingham or Glasgow. You can also search without a city.';
    }
    if (context.catalogCountry === 'ireland' && search.sponsorship !== 'any') {
        clarification =
            'The sponsorship filters refer to UK employer licences and UK role evidence. Your saved profile uses the Ireland catalogue, so I cannot apply those filters to Irish employment permits. Remove the sponsorship filter to search this catalogue.';
    }
    if (context.catalogCountry === 'ireland' && search.employerScope === 'civil-service') {
        clarification =
            'This filter searches the UK Civil Service. Your profile currently uses the Ireland catalogue. Update the target country in your profile for UK roles, or remove the Civil Service filter to keep searching Ireland.';
    }
    if (search.unsupported.length) {
        clarification =
            baseline.clarification ||
            `I cannot verify these requirements from the current catalogue: ${search.unsupported.join(', ')}. Please remove these filters or give me a supported alternative; I have kept the other criteria.`;
    }
    if (countryConflict) {
        clarification = `You asked for ${targetCountry === 'uk' ? 'UK' : 'Ireland'} jobs, but your saved profile uses the ${context.catalogCountry === 'uk' ? 'UK' : 'Ireland'} catalogue. Update the target country in your profile to search that catalogue. I have not substituted jobs from a different country.`;
    }
    if (clarification) {
        return {
            mode: 'clarification',
            message: [clarification, ...baseline.notes].filter(Boolean).join('\n\n'),
            search,
            jobs: [],
            totalCount: 0,
            evidence: {},
            suggestions: suggestions(search),
            interpretation,
            web,
            groundedWebStatus: web.requested ? 'skipped' : 'not_requested',
        };
    }

    const isPremium = search.kind === 'part-time' ? context.partTimePremium : context.careerPremium;
    const isSearch = hasChatCriteria(search);
    const maxJobsReturned = isPremium ? undefined : isSearch ? FREE_SEARCH_JOBS_LIMIT : FREE_BROWSE_JOBS_LIMIT;
    const webPromise = async (): Promise<JobsPortalJob[]> => {
        if (!web.requested) return [];
        if (!isPremium) {
            web.status = 'premium_required';
            return [];
        }
        if (!deps.webFeed) {
            web.status = 'disabled';
            return [];
        }
        try {
            const found = await deps.webFeed(search, context.catalogCountry);
            web.examined = found.examined;
            web.retrievedAt = found.retrievedAt;
            web.cacheHit = found.cacheHit;
            web.boardsChecked = found.boardsChecked;
            web.boardsFailed = found.boardsFailed;
            web.boardsAvailable = found.boardsAvailable;
            web.limitReached = found.limitReached;
            let candidates = toPublicPortalJobs(found.jobs);
            if (candidates.length && deps.enrichWebJobs) {
                try {
                    candidates = await deps.enrichWebJobs(candidates);
                } catch {
                    if (search.sponsorship !== 'any') throw new Error('Employer evidence unavailable');
                }
            }
            const accepted = candidates.filter((job) => matchChatJob(job, search).matches);
            web.matched = accepted.length;
            web.excluded = Math.min(found.examined, found.excluded + found.jobs.length - accepted.length);
            web.status = 'searched';
            return accepted;
        } catch {
            web.status = 'unavailable';
            return [];
        }
    };
    const groundedState: { status: NonNullable<JobChatResponse['groundedWebStatus']>; note?: string } = {
        status: web.requested ? 'skipped' : 'not_requested',
    };
    const groundedPromise = async (): Promise<ChatGroundedWeb | undefined> => {
        if (!web.requested) return undefined;
        if (!isPremium) {
            groundedState.status = 'premium_required';
            return undefined;
        }
        if (!deps.groundedSearch) {
            groundedState.status = 'unavailable';
            groundedState.note = 'Google Search is not configured on this server. Catalogue and employer-site searches are handled separately.';
            return undefined;
        }
        try {
            const research = await deps.groundedSearch(search, context.catalogCountry);
            groundedState.status = 'searched';
            return research;
        } catch (error) {
            if (error instanceof ChatGoogleWebError && error.code === 'UNSUPPORTED') {
                groundedState.status = 'skipped';
                groundedState.note = search.sponsorship !== 'any'
                    ? 'Google Search was not run because it cannot establish CAFY’s sponsor-licence or advert sponsorship evidence. Your sponsorship filter remains applied to the catalogue and employer adverts.'
                    : 'Google Search was not run because it cannot verify one or more active filters. Your criteria remain applied to the catalogue and employer adverts.';
                return undefined;
            }
            groundedState.status = 'unavailable';
            if (error instanceof ChatGoogleWebError) {
                switch (error.reason) {
                    case 'search-evidence':
                        groundedState.note = 'Google did not provide the source evidence needed to support this search. Your filters are saved; you can retry.';
                        break;
                    case 'retrieval-evidence':
                        groundedState.note = 'Google returned search sources, but could not retrieve supported individual adverts. Your filters are saved; you can retry.';
                        break;
                    case 'invalid-adverts':
                        groundedState.note = 'The web adverts returned did not pass CAFY’s source, date or filter checks. Your filters are saved; you can retry.';
                        break;
                    case 'rate-limited':
                        groundedState.note = 'Google’s search service is temporarily rate-limited. Please try again shortly. Your filters are saved.';
                        break;
                    case 'provider-unavailable':
                        groundedState.note = 'Google’s search service could not complete this lookup. Please try again. Your filters are saved.';
                        break;
                }
            }
            return undefined;
        }
    };
    let catalogueUnavailable = false;
    const cataloguePromise = async (): Promise<ChatCatalogueResult> => {
        try {
            return await (search.kind === 'part-time' ? deps.partTimeFeed : deps.careerFeed)(search, maxJobsReturned);
        } catch (error) {
            if (error instanceof ChatExecutionError) throw error;
            catalogueUnavailable = true;
            return {
                jobs: [], totalCount: 0, totalPages: 1, globalTotalCount: 0,
                evidence: {},
            };
        }
    };
    const [result, webJobs, groundedWeb] = await Promise.all([
        cataloguePromise(),
        webPromise(),
        groundedPromise(),
    ]);
    const groundedWebStatus = groundedState.status;
    const combinedJobs =
        web.status === 'searched' ? mergeChatJobSources(toPublicPortalJobs(result.jobs), webJobs) : result.jobs;
    const combinedResult =
        web.status === 'searched'
            ? {
                  ...result,
                  jobs: combinedJobs,
                  totalCount: combinedJobs.length,
                  totalPages: Math.max(1, Math.ceil(combinedJobs.length / JOBS_PAGE_SIZE)),
              }
            : result;
    const { feed, access } = applyJobsPortalEntitlements(combinedResult, {
        isPremium,
        // All supported hard filters count as search for entitlements, including salary-only queries.
        q: isSearch ? 'chat-filtered-search' : undefined,
    });
    let jobs = toPublicPortalJobs(feed.jobs).slice(0, isPremium ? JOBS_PAGE_SIZE : maxJobsReturned);
    if (jobs.length && deps.hydrateJobs) {
        const hydrated = await deps.hydrateJobs(search, jobs);
        const descriptions = new Map(
            hydrated
                .filter(
                    (job) =>
                        typeof job.id === 'string' && typeof job.description === 'string' && job.description.trim(),
                )
                .map((job) => [job.id, job.description!.trim()]),
        );
        jobs = jobs.map((job) => (descriptions.has(job.id) ? { ...job, description: descriptions.get(job.id)! } : job));
    }
    const allEvidence = {
        ...result.evidence,
        ...Object.fromEntries(webJobs.map((job) => [job.id, matchChatJob(job, search).evidence])),
    };
    const evidence: Record<string, string[]> = Object.fromEntries(
        jobs
            .filter((job) => Array.isArray(allEvidence[job.id]))
            .map((job) => [job.id, allEvidence[job.id]!.filter((item) => typeof item === 'string').slice(0, 12)]),
    );
    web.returned = jobs.filter((job) => job.listingSource?.kind === 'web').length;
    const naturalSearch = [
        search.role ? `“${search.role}” ${jobs.length === 1 ? 'role' : 'roles'}` : jobs.length === 1 ? 'role' : 'roles',
        search.employerScope === 'civil-service' ? 'in the UK Civil Service' : '',
        search.employer ? `at ${search.employer}` : '',
        search.where ? `in ${search.where}` : '',
    ]
        .filter(Boolean)
        .join(' ');
    const partial = catalogueUnavailable || result.coverage?.limitReached === true || web.limitReached === true;
    const intro = jobs.length
        ? `I found ${jobs.length} matching ${naturalSearch}. Each card explains the criteria it meets. Choose a role to read the advert or work on your CV.`
        : catalogueUnavailable
          ? `I couldn’t complete your search for ${naturalSearch}. Please try again. I’ve kept your filters.`
        : `I haven’t found an exact match for ${naturalSearch} in the CAFY catalogue and employer adverts checked so far. I’ve kept your filters.`;
    const catalogueNote = catalogueUnavailable
        ? web.returned > 0
            ? 'The CAFY catalogue could not be checked; the job cards shown come from the other sources available.'
            : 'The CAFY catalogue could not be checked for this request. Your filters are saved so you can retry.'
        : '';
    const coverage = partial ? 'This is a limited search; more matching adverts may remain.' : '';
    const cap =
        !isPremium && access.hasMoreResults
            ? `Your current plan shows a ${access.previewLimit}-job search preview. The full results require Jobs Premium${search.kind === 'part-time' ? ' or a part-time plan' : ''}.`
            : '';
    const webNote =
        web.status === 'disabled'
            ? 'Web search is not enabled yet; the catalogue search still works.'
            : web.status === 'premium_required'
              ? 'Additional web search requires the relevant jobs plan. Your CAFY catalogue preview is shown.'
              : web.status === 'unavailable'
                ? 'Some employer sources couldn’t be checked, so I can’t rule out further matches.'
                : '';
    const researchNote = groundedState.note || (
        groundedWebStatus === 'searched'
            ? groundedWeb?.format === 'job-cards' && groundedWeb.cards?.length === 0
                ? 'Google Search completed, but it could not support individual adverts for these filters. I’ve kept your criteria.'
                : 'I also looked for individual adverts on the web. Review those discoveries below and check the original advert before applying.'
            : groundedWebStatus === 'unavailable'
              ? 'The web lookup couldn’t return supported individual adverts this time. You can retry or refine the search.'
              : '');
    return {
        mode: 'search',
        catalogueStatus: catalogueUnavailable ? 'unavailable' : 'searched',
        message: [intro, catalogueNote, coverage, webNote, researchNote, cap, ...baseline.notes].filter(Boolean).join('\n\n'),
        search,
        jobs,
        totalCount: feed.totalCount,
        access,
        ...(result.coverage ? { coverage: result.coverage } : {}),
        evidence,
        suggestions: suggestions(search),
        interpretation,
        web,
        groundedWebStatus,
        ...(groundedWeb ? { groundedWeb } : {}),
    };
}
