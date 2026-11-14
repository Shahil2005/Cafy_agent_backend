import type { ChatSearch } from './chatIntent';
import type { JobsCatalogCountry } from './jobsCatalog';
import { searchChatEmployerWebJobs, ChatLiveWebError, type ChatLiveWebResult } from './chatLiveWeb';
import { searchChatGovernmentJobs } from './chatGovernmentSources';
import { mergeChatJobSources } from './chatWebMerge';

export interface ChatDiscoveryDependencies {
    signal?: AbortSignal;
    employerSearch?: typeof searchChatEmployerWebJobs;
    governmentSearch?: typeof searchChatGovernmentJobs;
    now?: () => number;
}

/** Independent public sources only. Google results are never inputs to these reads. */
export async function searchChatJobSources(
    search: ChatSearch,
    country: JobsCatalogCountry,
    deps: ChatDiscoveryDependencies = {},
): Promise<ChatLiveWebResult> {
    if (deps.signal?.aborted) throw new ChatLiveWebError('UNAVAILABLE');
    const employerSearch = deps.employerSearch || searchChatEmployerWebJobs;
    const governmentSearch = deps.governmentSearch || searchChatGovernmentJobs;
    const lookups: Array<Promise<ChatLiveWebResult>> = [employerSearch(search, country, { signal: deps.signal })];
    // An ineligible source returning an empty object must not mask an outage of
    // the only relevant source. Work Hub covers the UK search, not Ireland.
    if (country === 'uk') lookups.push(governmentSearch(search, country, { signal: deps.signal }));
    const observations = await Promise.allSettled(lookups);
    if (deps.signal?.aborted) throw new ChatLiveWebError('UNAVAILABLE');
    if (observations.every((value) => value.status === 'rejected')) throw new ChatLiveWebError('UNAVAILABLE');
    const result: ChatLiveWebResult = {
        jobs: [],
        examined: 0,
        excluded: 0,
        retrievedAt: new Date((deps.now || Date.now)()).toISOString(),
        cacheHit: false,
        boardsChecked: 0,
        boardsFailed: 0,
        boardsAvailable: 0,
        limitReached: false,
    };
    for (const observation of observations) {
        if (observation.status === 'rejected') {
            // Discovery itself can fail before the number of boards is known.
            // Count the failed source, without inventing a board/ad count.
            result.boardsChecked++;
            result.boardsFailed++;
            result.boardsAvailable++;
            result.limitReached = true;
            continue;
        }
        const found = observation.value;
        const combined = mergeChatJobSources(result.jobs, found.jobs);
        result.excluded += found.excluded + result.jobs.length + found.jobs.length - combined.length;
        result.jobs = combined;
        result.examined += found.examined;
        result.boardsChecked += found.boardsChecked;
        result.boardsFailed += found.boardsFailed;
        result.boardsAvailable += found.boardsAvailable;
        result.limitReached ||= found.limitReached;
    }
    return result;
}
