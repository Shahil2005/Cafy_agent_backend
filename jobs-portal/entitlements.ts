import { isBillingEnabled } from '../billing/config';
import {
    refreshSubscriptionIfExpired,
    isJobsPremiumActive,
    isPartTimePremiumActive,
} from '../billing/subscriptionService';
import {
    COMPANIES_PAGE_SIZE,
    FREE_BROWSE_JOBS_LIMIT,
    FREE_COMPANIES_LIMIT,
    FREE_SEARCH_JOBS_LIMIT,
    JOBS_PAGE_SIZE,
} from './constants';

export type JobsPortalMode = 'browse' | 'search';

export interface JobsFeedResult {
    jobs: unknown[];
    totalPages: number;
    totalCount: number;
    globalTotalCount: number;
    preferredTotalCount?: number;
    remainderTotalCount?: number;
    browseHasSectorPreferences?: boolean;
}

export interface JobsPortalAccessMeta {
    isPremium: boolean;
    mode: JobsPortalMode;
    jobsReturned: number;
    previewLimit: number;
    premiumRequiredFor: Array<'pagination' | 'full_search'>;
    /** Full match count before free cap — for upgrade UI only, not pagination */
    trueTotalCount?: number;
    /** True when more jobs exist than the free preview returned */
    hasMoreResults?: boolean;
}

/** Fail closed when billing is disabled — treat as Free for jobs gating. */
export async function isUserPremiumForJobs(
    uid: string,
    preloadedSubscription?: import('../billing/subscriptionService').UserSubscription | null
): Promise<boolean> {
    if (!isBillingEnabled()) {
        return false;
    }
    const subscription = await refreshSubscriptionIfExpired(uid, preloadedSubscription);
    return isJobsPremiumActive(subscription);
}

/** Full UK part-time catalog — part-time weekly, Jobs Premium, or Full Premium. */
export async function isUserPremiumForPartTime(
    uid: string,
    preloadedSubscription?: import('../billing/subscriptionService').UserSubscription | null
): Promise<boolean> {
    if (!isBillingEnabled()) {
        return false;
    }
    const subscription = await refreshSubscriptionIfExpired(uid, preloadedSubscription);
    return isPartTimePremiumActive(subscription);
}

export function resolveJobsPortalMode(options: {
    role?: string;
    where?: string;
    q?: string;
    /** Part-time city filter — same free cap as search (1 job). */
    city?: string;
}): JobsPortalMode {
    const role = (options.role || '').trim();
    const where = (options.where || '').trim();
    const q = (options.q || '').trim();
    const city = (options.city || '').trim();
    return role || where || q || city ? 'search' : 'browse';
}

/**
 * Enforce jobs portal limits server-side. Full feed is computed first; only the
 * allowed slice is returned so Free users cannot paginate or inspect all rows.
 */
function stripInternalJobFields(job: unknown): unknown {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return job;
    const { feedSegment: _feedSegment, ...rest } = job as Record<string, unknown>;
    return rest;
}

export function applyJobsPortalEntitlements(
    feed: JobsFeedResult,
    options: { isPremium: boolean; role?: string; where?: string; q?: string; city?: string }
): { feed: JobsFeedResult; access: JobsPortalAccessMeta } {
    const mode = resolveJobsPortalMode(options);
    const isPremium = options.isPremium;

    const trueTotalCount = feed.totalCount;
    const trueTotalPages = Math.max(1, feed.totalPages);

    if (isPremium) {
        return {
            feed: {
                ...feed,
                totalCount: trueTotalCount,
                totalPages: trueTotalPages,
            },
            access: {
                isPremium: true,
                mode,
                jobsReturned: feed.jobs.length,
                previewLimit: JOBS_PAGE_SIZE,
                premiumRequiredFor: [],
            },
        };
    }

    if (mode === 'search') {
        const cappedJobs = feed.jobs.slice(0, FREE_SEARCH_JOBS_LIMIT).map(stripInternalJobFields);
        const visibleTotalCount = Math.min(trueTotalCount, FREE_SEARCH_JOBS_LIMIT);
        const hasMoreResults = trueTotalCount > FREE_SEARCH_JOBS_LIMIT;
        return {
            feed: {
                jobs: cappedJobs,
                totalCount: visibleTotalCount,
                totalPages: 1,
                globalTotalCount: feed.globalTotalCount,
            },
            access: {
                isPremium: false,
                mode: 'search',
                jobsReturned: cappedJobs.length,
                previewLimit: FREE_SEARCH_JOBS_LIMIT,
                premiumRequiredFor: ['pagination', 'full_search'],
                hasMoreResults,
                trueTotalCount,
            },
        };
    }

    const cappedJobs = feed.jobs.slice(0, FREE_BROWSE_JOBS_LIMIT).map(stripInternalJobFields);
    const visibleTotalCount = Math.min(trueTotalCount, FREE_BROWSE_JOBS_LIMIT);
    const hasMoreResults = trueTotalCount > FREE_BROWSE_JOBS_LIMIT;
    return {
        feed: {
            jobs: cappedJobs,
            totalCount: visibleTotalCount,
            totalPages: 1,
            globalTotalCount: feed.globalTotalCount,
            ...(feed.browseHasSectorPreferences
                ? { browseHasSectorPreferences: true }
                : {}),
        },
        access: {
            isPremium: false,
            mode: 'browse',
            jobsReturned: cappedJobs.length,
            previewLimit: FREE_BROWSE_JOBS_LIMIT,
            premiumRequiredFor: ['pagination'],
            hasMoreResults,
            trueTotalCount,
        },
    };
}

export interface CompaniesDirectoryResult {
    companies: unknown[];
    totalPages: number;
    totalCount: number;
}

export interface CompaniesPortalAccessMeta {
    isPremium: boolean;
    companiesReturned: number;
    previewLimit: number;
    premiumRequiredFor: Array<'pagination' | 'full_search'>;
    trueTotalCount?: number;
    hasMoreResults?: boolean;
}

export function applyCompaniesPortalEntitlements(
    result: CompaniesDirectoryResult,
    isPremium: boolean
): { result: CompaniesDirectoryResult; access: CompaniesPortalAccessMeta } {
    const trueTotalCount = result.totalCount;

    if (isPremium) {
        return {
            result,
            access: {
                isPremium: true,
                companiesReturned: result.companies.length,
                previewLimit: COMPANIES_PAGE_SIZE,
                premiumRequiredFor: [],
            },
        };
    }

    const capped = result.companies.slice(0, FREE_COMPANIES_LIMIT);
    return {
        result: {
            companies: capped,
            totalCount: Math.min(trueTotalCount, FREE_COMPANIES_LIMIT),
            totalPages: 1,
        },
        access: {
            isPremium: false,
            companiesReturned: capped.length,
            previewLimit: FREE_COMPANIES_LIMIT,
            premiumRequiredFor: ['pagination', 'full_search'],
            hasMoreResults: trueTotalCount > FREE_COMPANIES_LIMIT,
        },
    };
}
