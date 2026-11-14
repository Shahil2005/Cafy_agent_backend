/**
 * jobsPortalRouter.ts
 *
 * Express Router for the Jobs Portal feature set.
 * All routes are mounted at /api/jobs-portal in server.ts.
 * Authentication is handled by the verifyToken middleware in server.ts before this router is reached.
 *
 * Endpoints:
 *   GET  /api/jobs-portal/jobs                – paginated job feed (Supabase read)
 *   GET  /api/jobs-portal/part-time/jobs      – UK part-time feed (part_time_jobs_UK)
 *   GET  /api/jobs-portal/part-time/jobs/:id  – one UK part-time job (premium)
 *   GET  /api/jobs-portal/companies           – company directory (UK/Ireland, job-count order)
 *   GET  /api/jobs-portal/companies/:id       – company profile + open roles for a catalog
 *   POST /api/jobs-portal/report              – report an expired job listing
 *   GET  /api/jobs-portal/sponsorship/data         – paginated UK sponsor search (in-memory cache, JSON)
 *   GET  /api/jobs-portal/sponsorship/ireland/data – paginated Ireland employment permits (in-memory cache, JSON)
 *   GET  /api/jobs-portal/preferences         – get user job preferences (Firestore)
 *   POST /api/jobs-portal/preferences         – save user job preferences (Firestore)
 */

import { Router, Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { handleJobsChat } from './chatHandler';
import { handleCareerMatches } from './careerMatchHandler';
import { aiLimiter } from '../middleware/rateLimiters';

import {
    getPartTimeJobById,
    getPartTimeJobsFeed,
    parsePartTimeJobId,
} from './partTimeFeed';
import { isPartTimeJobsBlocked } from './partTimeAccess';
import { parsePartTimeRoleQuery } from './partTimeSearch';
import { officialPartTimeCity } from './partTimeCities';
import {
    getJobsFeed,
    getPortalJobById,
    reportJobListing,
    querySponsorshipData,
    getUserPreferences,
    saveUserPreferences,
    getCareerBrowsePreferences,
    normalizeSponsorshipSearchQuery,
    normalizeSponsorshipCityFilter,
} from './service';
import {
    queryIrelandSponsorshipData,
    normalizeIrelandCityFilter,
    normalizeIrelandYearFilter,
    normalizeIrelandRangeFilter,
} from './irelandSponsorship';
import {
    getSponsorshipFavorites,
    saveSponsorshipFavorites,
    mergeLocalSponsorshipFavorites,
    parseSponsorshipFavoriteListKey,
} from './sponsorshipFavorites';
import { listPortalCompanies, getCompanyDirectoryDetail, isFreePreviewCompany } from './companiesDirectory';
import { isRegisterOnlyCompanyId } from './directoryIds';
import { JOB_CATALOG_LEVELS } from './constants';
import { sanitizeUserSectors } from './sectorPreferences';
import {
    applyCompaniesPortalEntitlements,
    applyJobsPortalEntitlements,
    isUserPremiumForJobs,
    isUserPremiumForPartTime,
} from './entitlements';
import { getUserBillingDoc } from '../billing/subscriptionService';
import {
    FREE_BROWSE_JOBS_LIMIT,
    FREE_COMPANIES_LIMIT,
    FREE_COMPANY_JOBS_LIMIT,
    FREE_SEARCH_JOBS_LIMIT,
    JOBS_PAGE_SIZE,
    COMPANIES_HOUSE_SEARCH_MAX_LENGTH,
    JOBS_SEARCH_QUERY_MAX_LENGTH,
} from './constants';
import { toDirectoryPortalCompany, toFreeDirectoryJobs, toPublicPortalJobs } from './publicResponse';
import {
    sponsorshipDataLimiter,
    sponsorshipFavoritesLimiter,
    companiesHouseSearchLimiter,
    jobsFeedLimiter,
} from '../middleware/rateLimiters';

const router = Router();

// AI may interpret intent only; listing rows always come through the existing gated catalogue.
router.post('/chat', aiLimiter, jobsFeedLimiter, handleJobsChat);
router.post('/career-matches', aiLimiter, jobsFeedLimiter, handleCareerMatches);

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/jobs
// Query params: page, role, where, q (legacy→role), excludedJobIds, excludedCompanyIds
// ---------------------------------------------------------------------------
router.get('/jobs', jobsFeedLimiter, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.uid as string | undefined;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
        const companyId = parseInt(req.query.companyId as string, 10) || undefined;

        const excludedJobIdsRaw = req.query.excludedJobIds as string;
        const excludedCompanyIdsRaw = req.query.excludedCompanyIds as string;

        const excludedJobIds = excludedJobIdsRaw
            ? excludedJobIdsRaw.split(',').filter(Boolean)
            : undefined;

        const excludedCompanyIds = excludedCompanyIdsRaw
            ? excludedCompanyIdsRaw.split(',').map(Number).filter(n => !isNaN(n))
            : undefined;

        const roleRaw = (req.query.role as string) || '';
        const whereRaw = (req.query.where as string) || '';
        const qRaw = (req.query.q as string) || '';
        const role = roleRaw.trim() || undefined;
        const where = whereRaw.trim() || undefined;
        const q = qRaw.trim() || undefined;
        const isSearch = Boolean(role || where || q);
        const refreshPreferences =
            req.query.refresh === '1' || req.query.refresh === 'true';

        // One users/{uid} read shared by premium check + preferences load.
        const userSnap = await admin.firestore().doc(`users/${userId}`).get();
        const { subscription, data: userData } = await getUserBillingDoc(userId, userSnap);

        const [isPremium, browsePrefs] = await Promise.all([
            isUserPremiumForJobs(userId, subscription),
            // Prefs always load: locations select catalog; sectors/levels/types soft-rank
            // browse and search (search hard-filters by role/where only).
            getCareerBrowsePreferences(userId, userData),
        ]);

        if (!isPremium && page > 1) {
            return res.status(403).json({
                error: 'JOBS_PREMIUM_REQUIRED',
                message:
                    'Upgrade to Premium to load more jobs or see full search results.',
                isPremium: false,
                jobs: [],
            });
        }

        const catalogCountry = browsePrefs.catalogCountry;

        if (!isPremium && companyId) {
            const allowed = await isFreePreviewCompany(catalogCountry, companyId);
            if (!allowed) {
                return res.status(403).json({
                    error: 'JOBS_PREMIUM_REQUIRED',
                    message: 'Upgrade to Premium to browse the full companies directory.',
                    isPremium: false,
                    jobs: [],
                });
            }
        }

        // Free users cannot use client-driven exclusions to page through the full catalog.
        const feedPage = isPremium ? page : 1;
        const feedExcludedJobIds = isPremium ? excludedJobIds : undefined;
        const feedExcludedCompanyIds = isPremium ? excludedCompanyIds : undefined;

        const maxJobsReturned = !isPremium
            ? companyId
                ? FREE_COMPANY_JOBS_LIMIT
                : isSearch
                    ? FREE_SEARCH_JOBS_LIMIT
                    : FREE_BROWSE_JOBS_LIMIT
            : undefined;

        const result = await getJobsFeed({
            page: feedPage,
            excludedJobIds: feedExcludedJobIds,
            excludedCompanyIds: feedExcludedCompanyIds,
            userSectors: browsePrefs.sectors,
            userExperienceLevels: browsePrefs.experienceLevels,
            userJobTypes: browsePrefs.jobTypes,
            role,
            where,
            q,
            companyId,
            userId,
            maxJobsReturned,
            refreshPreferences,
            catalogCountry,
        });

        const { feed, access } = applyJobsPortalEntitlements(result, {
            isPremium,
            role,
            where,
            q,
        });

        return res.status(200).json({
            ...feed,
            jobs: toPublicPortalJobs(feed.jobs as unknown[]),
            access,
        });
    } catch (error) {
        console.error('[jobsPortalRouter] GET /jobs error:', error);
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        return res.status(500).json({ error: message });
    }
});

router.get('/jobs/:jobId', jobsFeedLimiter, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.uid as string | undefined;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const jobId = String(req.params.jobId || '').trim();
        if (!jobId) {
            return res.status(400).json({ error: 'Missing job id' });
        }

        const userSnap = await admin.firestore().doc(`users/${userId}`).get();
        const { subscription, data: userData } = await getUserBillingDoc(userId, userSnap);
        const [isPremium, browsePrefs] = await Promise.all([
            isUserPremiumForJobs(userId, subscription),
            getCareerBrowsePreferences(userId, userData),
        ]);

        // Free users see only the capped list. This endpoint must not be an
        // enumeration hole for the rest of the catalog.
        if (!isPremium) {
            return res.status(403).json({
                error: 'JOBS_PREMIUM_REQUIRED',
                message: 'Upgrade to Premium to see more jobs.',
            });
        }

        const job = await getPortalJobById(jobId, browsePrefs.catalogCountry);

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        return res.status(200).json({ job });
    } catch (error) {
        console.error('[jobsPortalRouter] GET /jobs/:jobId error:', error);
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        return res.status(500).json({ error: message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/part-time/jobs
// UK part-time catalog only. Query params: page, city, role, company (q = legacy role).
// ---------------------------------------------------------------------------
router.get('/part-time/jobs', jobsFeedLimiter, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.uid as string | undefined;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
        const role = ((req.query.role as string) || '').trim() || undefined;
        const company = ((req.query.company as string) || '').trim() || undefined;
        const q = ((req.query.q as string) || '').trim() || undefined;
        if (
            (role?.length ?? 0) > JOBS_SEARCH_QUERY_MAX_LENGTH ||
            (company?.length ?? 0) > JOBS_SEARCH_QUERY_MAX_LENGTH ||
            (q?.length ?? 0) > JOBS_SEARCH_QUERY_MAX_LENGTH
        ) {
            return res.status(400).json({
                error: `Search must be ${JOBS_SEARCH_QUERY_MAX_LENGTH} characters or less`,
            });
        }
        // A role of only filler words ("part time jobs") is not a search.
        const roleText = role || q;
        const effectiveRole =
            roleText && parsePartTimeRoleQuery(roleText).terms.length > 0 ? roleText : undefined;
        const isSearch = Boolean(effectiveRole || company);
        const requestedCity = ((req.query.city as string) || '').trim();

        const userSnap = await admin.firestore().doc(`users/${userId}`).get();
        const { subscription, data: userData } = await getUserBillingDoc(userId, userSnap);
        if (isPartTimeJobsBlocked(userData)) {
            return res.status(403).json({
                error: 'PART_TIME_UK_ONLY',
                message: 'Part-time jobs are available for United Kingdom profiles.',
            });
        }

        let city = requestedCity ? officialPartTimeCity(requestedCity) ?? undefined : undefined;
        if (requestedCity && !city) {
            return res.status(400).json({ error: 'Unknown city' });
        }

        const isPremium = await isUserPremiumForPartTime(userId, subscription);

        if (!isPremium && page > 1) {
            return res.status(403).json({
                error: 'JOBS_PREMIUM_REQUIRED',
                message: 'Upgrade to unlock more part-time jobs.',
                isPremium: false,
                jobs: [],
            });
        }

        const isCityFilter = Boolean(city);
        const maxJobsReturned = !isPremium
            ? isSearch || isCityFilter
                ? FREE_SEARCH_JOBS_LIMIT
                : FREE_BROWSE_JOBS_LIMIT
            : undefined;

        const result = await getPartTimeJobsFeed({
            page: isPremium ? page : 1,
            role: effectiveRole,
            company,
            city: city ?? undefined,
            userId,
            maxJobsReturned,
        });

        const { feed, access } = applyJobsPortalEntitlements(result, {
            isPremium,
            role: effectiveRole,
            where: company,
            city,
        });

        return res.status(200).json({
            ...feed,
            jobs: toPublicPortalJobs(feed.jobs as unknown[]),
            access,
        });
    } catch (error) {
        console.error('[jobsPortalRouter] GET /part-time/jobs error:', error);
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        return res.status(500).json({ error: message });
    }
});

router.get('/part-time/jobs/:jobId', jobsFeedLimiter, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.uid as string | undefined;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const jobId = parsePartTimeJobId(String(req.params.jobId || ''));
        if (!jobId) {
            return res.status(400).json({ error: 'Missing job id' });
        }

        const userSnap = await admin.firestore().doc(`users/${userId}`).get();
        const { subscription, data: userData } = await getUserBillingDoc(userId, userSnap);
        if (isPartTimeJobsBlocked(userData)) {
            return res.status(403).json({
                error: 'PART_TIME_UK_ONLY',
                message: 'Part-time jobs are available for United Kingdom profiles.',
            });
        }
        const isPremium = await isUserPremiumForPartTime(userId, subscription);

        if (!isPremium) {
            return res.status(403).json({
                error: 'JOBS_PREMIUM_REQUIRED',
                message: 'Upgrade to unlock this part-time job.',
            });
        }

        const job = await getPartTimeJobById(jobId, userId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        return res.status(200).json({ job: toPublicPortalJobs([job])[0] });
    } catch (error) {
        console.error('[jobsPortalRouter] GET /part-time/jobs/:jobId error:', error);
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        return res.status(500).json({ error: message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/job-levels — distinct experience levels in the jobs catalog
// ---------------------------------------------------------------------------
router.get('/job-levels', async (_req: Request, res: Response) => {
    return res.status(200).json({ levels: JOB_CATALOG_LEVELS });
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/companies
// Query params: catalog=uk|ireland, page, q
// ---------------------------------------------------------------------------
router.get('/companies', jobsFeedLimiter, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.uid as string | undefined;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
        const q = typeof req.query.q === 'string' ? req.query.q : undefined;

        const userSnap = await admin.firestore().doc(`users/${userId}`).get();
        const { subscription, data: userData } = await getUserBillingDoc(userId, userSnap);

        const [isPremium, browsePrefs] = await Promise.all([
            isUserPremiumForJobs(userId, subscription),
            getCareerBrowsePreferences(userId, userData),
        ]);

        if (!isPremium && page > 1) {
            return res.status(403).json({
                error: 'JOBS_PREMIUM_REQUIRED',
                message: 'Upgrade to Premium to browse the full companies directory.',
                isPremium: false,
                companies: [],
            });
        }

        const catalogCountry = browsePrefs.catalogCountry;
        const search = typeof q === 'string' ? q.trim() : '';

        if (!isPremium && search) {
            return res.status(403).json({
                error: 'JOBS_PREMIUM_REQUIRED',
                message: 'Upgrade to Premium to search the companies directory.',
                isPremium: false,
                companies: [],
            });
        }

        if (!isPremium) {
            const preview = await listPortalCompanies({
                catalogCountry,
                page: 1,
                pageSize: Math.max(FREE_COMPANIES_LIMIT * 4, 40),
            });
            const companies = preview.companies
                .filter(
                    (company) =>
                        (company.active_jobs_count || 0) > 0 && !isRegisterOnlyCompanyId(company.id)
                )
                .slice(0, FREE_COMPANIES_LIMIT)
                .map((company) =>
                    toDirectoryPortalCompany(
                        company as unknown as Record<string, unknown>,
                        company.active_jobs_count
                    )
                );

            return res.status(200).json({
                companies,
                totalCount: companies.length,
                totalPages: 1,
                catalogCountry,
                access: {
                    isPremium: false,
                    companiesReturned: companies.length,
                    previewLimit: FREE_COMPANIES_LIMIT,
                    premiumRequiredFor: ['pagination', 'full_search'],
                    hasMoreResults: preview.totalCount > FREE_COMPANIES_LIMIT,
                },
            });
        }

        const listed = await listPortalCompanies({
            catalogCountry,
            page,
            q,
        });

        const { result, access } = applyCompaniesPortalEntitlements(listed, true);

        return res.status(200).json({
            ...result,
            catalogCountry: listed.catalogCountry,
            access,
        });
    } catch (error) {
        console.error('[jobsPortalRouter] GET /companies error:', error);
        return res.status(500).json({ error: 'Failed to fetch companies' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/companies/:companyId
// Query params: catalog=uk|ireland, page
// ---------------------------------------------------------------------------
router.get('/companies/:companyId', jobsFeedLimiter, async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.uid as string | undefined;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const companyId = parseInt(req.params.companyId, 10);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return res.status(400).json({ error: 'Invalid company' });
        }

        const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);

        const userSnap = await admin.firestore().doc(`users/${userId}`).get();
        const { subscription, data: userData } = await getUserBillingDoc(userId, userSnap);

        const [isPremium, browsePrefs] = await Promise.all([
            isUserPremiumForJobs(userId, subscription),
            getCareerBrowsePreferences(userId, userData),
        ]);

        if (!isPremium && page > 1) {
            return res.status(403).json({
                error: 'JOBS_PREMIUM_REQUIRED',
                message: 'Upgrade to Premium to see every role at this company.',
                isPremium: false,
                jobs: [],
            });
        }

        const catalogCountry = browsePrefs.catalogCountry;

        if (!isPremium) {
            const allowed = await isFreePreviewCompany(catalogCountry, companyId);
            if (!allowed) {
                return res.status(403).json({
                    error: 'JOBS_PREMIUM_REQUIRED',
                    message: 'Upgrade to Premium to browse the full companies directory.',
                    isPremium: false,
                    jobs: [],
                });
            }
        }

        const detail = await getCompanyDirectoryDetail({
            companyId,
            catalogCountry,
            page: isPremium ? page : 1,
            pageSize: isPremium ? undefined : FREE_COMPANY_JOBS_LIMIT,
        });

        if (!detail) {
            return res.status(404).json({ error: 'Company not found' });
        }

        const jobs = isPremium
            ? toPublicPortalJobs(detail.jobs as unknown[])
            : toFreeDirectoryJobs(detail.jobs.slice(0, FREE_COMPANY_JOBS_LIMIT) as unknown[]);
        const trueTotalCount = detail.totalCount;
        const company = toDirectoryPortalCompany(
            detail.company as unknown as Record<string, unknown>,
            detail.company.active_jobs_count
        );

        return res.status(200).json({
            company,
            jobs,
            totalCount: isPremium ? trueTotalCount : jobs.length,
            totalPages: isPremium ? detail.totalPages : 1,
            catalogCountry: detail.catalogCountry,
            access: {
                isPremium,
                jobsReturned: jobs.length,
                previewLimit: isPremium ? JOBS_PAGE_SIZE : FREE_COMPANY_JOBS_LIMIT,
                premiumRequiredFor: isPremium ? [] : ['pagination'],
                ...(isPremium
                    ? {}
                    : {
                          hasMoreResults: trueTotalCount > FREE_COMPANY_JOBS_LIMIT,
                      }),
            },
        });
    } catch (error) {
        console.error('[jobsPortalRouter] GET /companies/:companyId error:', error);
        return res.status(500).json({ error: 'Failed to fetch company' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/jobs-portal/report
// Body: { jobId: number, reason?: string }
// ---------------------------------------------------------------------------
router.post('/report', async (req: Request, res: Response) => {
    try {
        const userId = (req as any).user?.uid;
        const email = (req as any).user?.email;
        const { jobId, jobTitle, companyName, reason } = req.body;

        if (!jobId || (typeof jobId !== 'number' && typeof jobId !== 'string')) {
            return res.status(400).json({ success: false, error: 'jobId is required' });
        }

        if (reason !== undefined && typeof reason !== 'string') {
            return res.status(400).json({ success: false, error: 'reason must be a string if provided' });
        }

        const result = await reportJobListing(userId, email, String(jobId), jobTitle, companyName, reason);
        return res.status(result.status || 200).json(result);
    } catch (error) {
        console.error('[jobsPortalRouter] POST /report error:', error);
        return res.status(500).json({ success: false, error: 'Failed to submit report' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/sponsorship/data
// Returns a paginated, server-filtered JSON slice of the UK sponsor register.
// CSV is parsed once into an in-memory cache; all subsequent requests are
// served entirely from memory — no disk I/O per request.
//
// Query params:
//   page   – 1-based page number (default: 1)
//   q      – free-text search across org name and city (max 100 chars)
//   city   – comma-separated town/city filter
// ---------------------------------------------------------------------------

router.get('/sponsorship/data', sponsorshipDataLimiter, async (req: Request, res: Response) => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
        let q: string | undefined;
        let cities: string[] | undefined;
        try {
            q = normalizeSponsorshipSearchQuery(
                typeof req.query.q === 'string' ? req.query.q : undefined
            );
            cities = normalizeSponsorshipCityFilter(
                typeof req.query.city === 'string' ? req.query.city : undefined
            );
        } catch (validationError) {
            const message = validationError instanceof Error
                ? validationError.message
                : 'Invalid search query';
            return res.status(400).json({ error: message });
        }

        const result = await querySponsorshipData(page, q, cities);

        // Cache at CDN/proxy for 1 hour; data changes at most once per day via cron
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(200).json(result);
    } catch (error) {
        console.error('[jobsPortalRouter] GET /sponsorship/data error:', error);
        return res.status(500).json({ error: 'Failed to load sponsorship data' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/sponsorship/ireland/data
// Returns a paginated, server-filtered JSON slice of Ireland employment permits.
//
// Query params:
//   page   – 1-based page number (default: 1)
//   q      – free-text search across employer name (max 100 chars)
//   city   – comma-separated city filter (e.g. Dublin,Cork)
// ---------------------------------------------------------------------------

router.get('/sponsorship/ireland/data', sponsorshipDataLimiter, async (req: Request, res: Response) => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
        let q: string | undefined;
        let cities: string[] | undefined;
        try {
            q = normalizeSponsorshipSearchQuery(
                typeof req.query.q === 'string' ? req.query.q : undefined
            );
            cities = normalizeIrelandCityFilter(
                typeof req.query.city === 'string' ? req.query.city : undefined
            );
        } catch (validationError) {
            const message = validationError instanceof Error
                ? validationError.message
                : 'Invalid search query';
            return res.status(400).json({ error: message });
        }

        const years = normalizeIrelandYearFilter(
            typeof req.query.years === 'string' ? req.query.years : undefined
        );
        const ranges = normalizeIrelandRangeFilter(
            typeof req.query.ranges === 'string' ? req.query.ranges : undefined
        );

        const result = await queryIrelandSponsorshipData(page, q, cities, years, ranges);

        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(200).json(result);
    } catch (error) {
        console.error('[jobsPortalRouter] GET /sponsorship/ireland/data error:', error);
        return res.status(500).json({ error: 'Failed to load Ireland employment permit data' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/preferences
// Returns the authenticated user's saved job search preferences.
// ---------------------------------------------------------------------------
router.get('/preferences', async (req: Request, res: Response) => {
    try {
        const uid = (req as any).user?.uid;
        if (!uid) return res.status(401).json({ error: 'Unauthorized' });

        const prefs = await getUserPreferences(uid);
        // 200 with null body = no prefs saved yet (first-time user)
        return res.status(200).json({ preferences: prefs });
    } catch (error) {
        console.error('[jobsPortalRouter] GET /preferences error:', error);
        return res.status(500).json({ error: 'Failed to load preferences' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/jobs-portal/preferences
// Save browse preferences (sectors + experience levels + job types) to users/{uid}.preferences.
// Body: { sectors?: string[], experienceLevels?: string[], jobTypes?: string[] }
// ---------------------------------------------------------------------------
router.post('/preferences', async (req: Request, res: Response) => {
    try {
        const uid = (req as any).user?.uid;
        if (!uid) return res.status(401).json({ error: 'Unauthorized' });

        const { sectors, experienceLevels, jobTypes } = req.body;

        if (sectors !== undefined && !Array.isArray(sectors)) {
            return res.status(400).json({ success: false, error: 'Invalid sectors format' });
        }
        if (experienceLevels !== undefined && !Array.isArray(experienceLevels)) {
            return res.status(400).json({ success: false, error: 'Invalid experienceLevels format' });
        }
        if (jobTypes !== undefined && !Array.isArray(jobTypes)) {
            return res.status(400).json({ success: false, error: 'Invalid jobTypes format' });
        }

        const result = await saveUserPreferences(uid, { sectors, experienceLevels, jobTypes });
        return res.status(result.success ? 200 : 500).json(result);
    } catch (error) {
        console.error('[jobsPortalRouter] POST /preferences error:', error);
        return res.status(500).json({ success: false, error: 'Failed to save preferences' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/sponsorship/favorites/:listKey
// Returns saved sponsorship hub favourites for the authenticated user.
// ---------------------------------------------------------------------------
router.get('/sponsorship/favorites/:listKey', async (req: Request, res: Response) => {
    try {
        const uid = (req as any).user?.uid;
        if (!uid) return res.status(401).json({ error: 'Unauthorized' });

        const listKey = parseSponsorshipFavoriteListKey(req.params.listKey);
        if (!listKey) return res.status(400).json({ error: 'Invalid favourites list' });

        const result = await getSponsorshipFavorites(uid, listKey);
        return res.status(200).json(result);
    } catch (error) {
        console.error('[jobsPortalRouter] GET /sponsorship/favorites error:', error);
        return res.status(500).json({ error: 'Failed to load favourites' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/jobs-portal/sponsorship/favorites/:listKey
// Replace favourites for a list (full snapshot sync).
// Body: { items: Array<{ id, label, snapshot, savedAt }> }
// ---------------------------------------------------------------------------
router.put('/sponsorship/favorites/:listKey', sponsorshipFavoritesLimiter, async (req: Request, res: Response) => {
    try {
        const uid = (req as any).user?.uid;
        if (!uid) return res.status(401).json({ error: 'Unauthorized' });

        const listKey = parseSponsorshipFavoriteListKey(req.params.listKey);
        if (!listKey) return res.status(400).json({ error: 'Invalid favourites list' });

        const result = await saveSponsorshipFavorites(uid, listKey, req.body?.items);
        return res.status(200).json(result);
    } catch (error) {
        console.error('[jobsPortalRouter] PUT /sponsorship/favorites error:', error);
        return res.status(500).json({ error: 'Failed to save favourites' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/jobs-portal/sponsorship/favorites/:listKey/merge
// One-time migration: upload local favourites when the server list is empty.
// Body: { items: Array<{ id, label, snapshot, savedAt }> }
// ---------------------------------------------------------------------------
router.post('/sponsorship/favorites/:listKey/merge', sponsorshipFavoritesLimiter, async (req: Request, res: Response) => {
    try {
        const uid = (req as any).user?.uid;
        if (!uid) return res.status(401).json({ error: 'Unauthorized' });

        const listKey = parseSponsorshipFavoriteListKey(req.params.listKey);
        if (!listKey) return res.status(400).json({ error: 'Invalid favourites list' });

        const result = await mergeLocalSponsorshipFavorites(uid, listKey, req.body?.items);
        return res.status(200).json(result);
    } catch (error) {
        console.error('[jobsPortalRouter] POST /sponsorship/favorites/merge error:', error);
        return res.status(500).json({ error: 'Failed to merge favourites' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs-portal/companies-house/search
// Backend proxy for organisation lookup.
// Keeps the API key server-side; the browser never touches the API directly.
//
// Query params:
//   q – company name to search (required)
//
// Response: { data: OrganisationResult | null }
// ---------------------------------------------------------------------------

const CH_API_BASE = 'https://api.company-information.service.gov.uk';

const SIC_DESCRIPTIONS: Record<string, string> = {
    '56101': 'Licensed restaurants',
    '96090': 'Other service activities not elsewhere classified',
    '62012': 'Business and domestic software development',
    '62020': 'Information technology consultancy activities',
    '70221': 'Financial management',
    '62011': 'Ready-made interactive leisure and entertainment software development',
};

async function chFetch(path: string, apiKey: string): Promise<any> {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const response = await fetch(`${CH_API_BASE}${path}`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) return null;

    if (!response.ok) {
        throw Object.assign(new Error(`CH API ${response.status}`), { status: response.status });
    }

    return response.json();
}

router.get('/companies-house/search', companiesHouseSearchLimiter, async (req: Request, res: Response) => {
    try {
        const qRaw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (!qRaw) {
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }
        if (qRaw.length > COMPANIES_HOUSE_SEARCH_MAX_LENGTH) {
            return res.status(400).json({
                error: `Query must be ${COMPANIES_HOUSE_SEARCH_MAX_LENGTH} characters or less`,
            });
        }
        const q = qRaw;

        const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
        if (!apiKey) {
            console.error('[org-lookup] API key not configured');
            return res.status(503).json({ error: 'Organisation lookup not configured' });
        }

        // Step 1: search by name, with legal-suffix fallback
        let searchData = await chFetch(`/search/companies?q=${encodeURIComponent(q)}`, apiKey);
        if (!searchData?.items?.length) {
            const stripped = q.replace(/\s+(LTD|LIMITED|LLP|PLC|COMPANY|CORPORATION)$/i, '').trim();
            if (stripped !== q) {
                searchData = await chFetch(`/search/companies?q=${encodeURIComponent(stripped)}`, apiKey);
            }
        }

        if (!searchData?.items?.length) {
            return res.status(200).json({ data: null });
        }

        const companyNumber: string = searchData.items[0].company_number;

        // Step 2: fetch full profile
        const profile = await chFetch(`/company/${companyNumber}`, apiKey);
        if (!profile) {
            return res.status(200).json({ data: null });
        }

        const addr = profile.registered_office_address ?? {};
        const addressParts = [
            addr.address_line_1, addr.address_line_2,
            addr.locality, addr.region, addr.postal_code, addr.country,
        ].filter(Boolean);

        const sicCodes: string[] = (profile.sic_codes ?? []).map((code: string) => {
            const desc = SIC_DESCRIPTIONS[code] ?? 'Business activity';
            return `${code} - ${desc}`;
        });

        res.setHeader('Cache-Control', 'private, max-age=86400');
        return res.status(200).json({
            data: {
                registrationNumber: profile.company_number,
                foundedYear: profile.date_of_creation
                    ? new Date(profile.date_of_creation).getFullYear().toString()
                    : null,
                registeredAddress: addressParts.join(', '),
                sicCodes,
                companyName: profile.company_name,
                companyType: profile.type,
            },
        });
    } catch (error: any) {
        console.error('[jobsPortalRouter] GET /companies-house/search error:', error);
        const isUpstream = error?.status && error.status >= 400 && error.status < 600;
        return res.status(isUpstream ? 502 : 500).json({ error: 'Organisation lookup unavailable' });
    }
});

export default router;
