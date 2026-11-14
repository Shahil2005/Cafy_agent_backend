import type { JobsTableName } from './jobsCatalog';
import { jobsTableSocDisplay } from './socDisplay';
import type { DirectoryPortalCompany, JobsPortalJob, PublicJobsPortalCompany } from './types';
import { publicSponsorshipAssessment } from './sponsorshipProjection';

/** Supabase select fragments — never use `*` for client-facing queries. */
export const PORTAL_JOB_LIST_COLUMNS =
    'id, title, url, location, department, level, sector, job_type, created_at, company_id';

const PORTAL_JOB_SOC_COLUMNS =
    'soc_code, soc_title, soc_confidence, soc_alternatives, soc_evidence, sponsorship_reasons, salary';

/** Extra columns for the quality / sponsorship catalogues (job-chat and sponsorship features). */
function portalJobTableExtras(table: string): string {
    const quality = table === 'quality_jobs' || table === 'quality_sponsorship_jobs';
    return `${quality ? ', salary, last_seen_at, description_checked_at, quality_version' : ''}${table === 'sponsorship_jobs' || table === 'quality_sponsorship_jobs' ? ', sponsorship_assessment' : ''}`;
}

/** Column list used by the CAFY chat. Unchanged behaviour: no SOC columns, optional description. */
export function portalJobChatColumns(table: string, includeDescription = false): string {
    return `${includeDescription ? PORTAL_JOB_COLUMNS : PORTAL_JOB_LIST_COLUMNS}${portalJobTableExtras(table)}`;
}

/** UK `jobs` rows include SOC columns. Ireland and other catalogs do not. */
export function portalJobListColumns(jobsTable: JobsTableName): string {
    const extras = portalJobTableExtras(jobsTable);
    if (jobsTable !== 'jobs') return `${PORTAL_JOB_LIST_COLUMNS}${extras}`;
    return `${PORTAL_JOB_LIST_COLUMNS}, ${PORTAL_JOB_SOC_COLUMNS}${extras}`;
}

export function portalJobColumns(jobsTable: JobsTableName): string {
    return `${portalJobListColumns(jobsTable)}, description`;
}

export const PORTAL_JOB_COLUMNS = `${PORTAL_JOB_LIST_COLUMNS}, description`;

export const PORTAL_JOB_COLUMNS_WITH_DESCRIPTION = PORTAL_JOB_COLUMNS;

/** Includes ireland_permit_employer — hydrate falls back if the column is missing. */
export const PORTAL_COMPANY_COLUMNS =
    'id, trading_name, companies_house_name, url, careers_url, url_linkedin, url_favicon, description, estimated_num_employees_label, licensed_sponsor, ireland_permit_employer, cos_used_count_2025, open_to_sponsorship, show_recently_added_badge, added_to_register';

export const PORTAL_COMPANY_COLUMNS_WITHOUT_IRELAND_PERMIT =
    'id, trading_name, companies_house_name, url, careers_url, url_linkedin, url_favicon, description, estimated_num_employees_label, licensed_sponsor, cos_used_count_2025, open_to_sponsorship, show_recently_added_badge, added_to_register';

/**
 * Prefer manual hydration via hydrateJobsWithCompanies.ts — PostgREST embeds
 * fail when the jobs→companies FK is missing from the schema cache.
 * Kept for any residual callers / docs.
 */
export const PORTAL_JOB_WITH_COMPANY_SELECT = `${PORTAL_JOB_COLUMNS}, company:companies!inner(${PORTAL_COMPANY_COLUMNS})`;

export function publicListingEvidence(value: unknown): JobsPortalJob['listingEvidence'] {
    if (!value || typeof value !== 'object') return undefined;
    const r = value as Record<string, unknown>;
    if (
        r.checksVersion !== 'content-v1' ||
        typeof r.sourceSeenAt !== 'string' ||
        typeof r.descriptionCheckedAt !== 'string' ||
        ![r.sourceSeenAt, r.descriptionCheckedAt].every(
            (s) => Number.isFinite(Date.parse(s)) && Date.parse(s) <= Date.now() + 300000,
        )
    )
        return undefined;
    return { sourceSeenAt: r.sourceSeenAt, descriptionCheckedAt: r.descriptionCheckedAt, checksVersion: 'content-v1' };
}

function pickString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function publicJobListingSource(value: unknown): JobsPortalJob['listingSource'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const validDate = (date: unknown): date is string =>
        typeof date === 'string' &&
        date.length <= 40 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(date) &&
        Number.isFinite(Date.parse(date));
    if (
        source.kind !== 'web' ||
        typeof source.provider !== 'string' ||
        !['jsearch', 'employer-sites'].includes(source.provider) ||
        (source.provider === 'employer-sites'
            ? source.availability !== 'source-listed'
            : source.availability !== 'unverified') ||
        typeof source.employerLicence !== 'string' ||
        !['unknown', 'catalogue-match'].includes(source.employerLicence) ||
        !validDate(source.retrievedAt) ||
        Date.parse(source.retrievedAt) > Date.now() + 300000 ||
        (source.publisher !== undefined && (typeof source.publisher !== 'string' || source.publisher.length > 150)) ||
        (source.postedAt !== undefined &&
            (!validDate(source.postedAt) || Date.parse(source.postedAt) > Date.now() + 300000)) ||
        (source.expiresAt !== undefined &&
            (!validDate(source.expiresAt) || Date.parse(source.expiresAt) > Date.now() + 10 * 366 * 86400000))
    )
        return undefined;
    return {
        kind: 'web',
        provider: source.provider as 'jsearch' | 'employer-sites',
        retrievedAt: source.retrievedAt,
        availability: source.availability as 'unverified' | 'source-listed',
        employerLicence: source.employerLicence as 'unknown' | 'catalogue-match',
        ...(typeof source.publisher === 'string' ? { publisher: source.publisher } : {}),
        ...(validDate(source.postedAt) ? { postedAt: source.postedAt } : {}),
        ...(validDate(source.expiresAt) ? { expiresAt: source.expiresAt } : {}),
    };
}

/** ATS cards often glue posted-time / applicant counts onto location. */
export function cleanPortalJobLocation(raw: unknown): string {
    let loc = pickString(raw).trim();
    if (!loc) return '';

    loc = loc
        .replace(
            /\s*(?:[·•|,/-]\s*)?(?:posted\s+)?(?:just\s+now|\d+\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?)\s+ago)\b[\s\S]*$/i,
            '',
        )
        .replace(/\s*\(\d+[^\)]*$/g, '')
        .replace(/[|·•,;:\-\s]+$/g, '')
        .replace(/^(uk|gb|ie)\s*[-–—/]\s*/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return loc;
}

function pickNullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? value : null;
}

function pickNumber(value: unknown, fallback = 0): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/** Coerce DB booleans that may arrive as real booleans or "TRUE"/"FALSE" strings. */
function pickBoolean(value: unknown): boolean {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value == null) return false;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }
    return false;
}

function pickNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Reject empty / placeholder company website values from imports. */
function usableCompanyUrl(value: unknown): string | null {
    const raw = pickNullableString(value);
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (
        lower === 'not found' ||
        lower === 'n/a' ||
        lower === 'na' ||
        lower === 'none' ||
        lower === '-' ||
        lower === 'null'
    ) {
        return null;
    }
    return trimmed;
}

export function fallbackCompanyDescription(tradingName: string): string {
    const name = tradingName.trim() || 'this company';
    return `Explore opportunities at ${name}. Learn more on their careers page and apply if the role looks like a fit.`;
}

function resolveCompanyWebsiteUrl(raw: Record<string, unknown>): string | null {
    return usableCompanyUrl(raw.url) ?? usableCompanyUrl(raw.careers_url);
}

function resolveCompanyDescription(raw: Record<string, unknown>, tradingName: string): string {
    const fromDb = pickNullableString(raw.description)?.trim();
    if (fromDb) return fromDb;
    return fallbackCompanyDescription(tradingName);
}

/**
 * Before `ireland_permit_employer` is migrated, Ireland-seeded rows (id >= 900000)
 * reused `licensed_sponsor=true` for the Irish badge. Keep that interim meaning only
 * when the new column is absent from the row.
 */
function resolveIrelandPermitEmployer(raw: Record<string, unknown>): boolean {
    if (Object.prototype.hasOwnProperty.call(raw, 'ireland_permit_employer')) {
        return pickBoolean(raw.ireland_permit_employer);
    }
    const id = pickNumber(raw.id);
    return id >= 900000 && pickBoolean(raw.licensed_sponsor);
}

export function toPublicPortalCompany(raw: Record<string, unknown>): PublicJobsPortalCompany {
    const trading_name = pickString(raw.trading_name) || 'Unknown Company';
    return {
        id: pickNumber(raw.id),
        trading_name,
        companies_house_name: pickNullableString(raw.companies_house_name),
        url: resolveCompanyWebsiteUrl(raw),
        url_linkedin: pickNullableString(raw.url_linkedin),
        url_favicon: pickNullableString(raw.url_favicon),
        // Always non-empty for portal clients — never ship a blank about section.
        description: resolveCompanyDescription(raw, trading_name),
        estimated_num_employees_label: pickNullableString(raw.estimated_num_employees_label),
        licensed_sponsor: pickBoolean(raw.licensed_sponsor),
        ireland_permit_employer: resolveIrelandPermitEmployer(raw),
        cos_used_count_2025: pickNullableNumber(raw.cos_used_count_2025),
        open_to_sponsorship: pickNullableNumber(raw.open_to_sponsorship),
        show_recently_added_badge: pickBoolean(raw.show_recently_added_badge),
        added_to_register: pickNullableString(raw.added_to_register),
    };
}

/** A job row is mapped once when it is loaded, then again for the API response. Keep the SOC view. */
function socAlreadyShown(value: unknown): JobsPortalJob['soc'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const soc = value as { kind?: unknown; code?: unknown; title?: unknown; reason?: unknown; matches?: unknown };
    const reason = typeof soc.reason === 'string' ? soc.reason : '';
    if (soc.kind === 'single' && typeof soc.code === 'string' && /^\d{4}$/.test(soc.code)) {
        return { kind: 'single', code: soc.code, title: typeof soc.title === 'string' ? soc.title : '', reason };
    }
    if (soc.kind !== 'candidates' || !Array.isArray(soc.matches)) return undefined;
    const matches = soc.matches.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const match = item as { code?: unknown; title?: unknown; percent?: unknown };
        if (typeof match.code !== 'string' || !/^\d{4}$/.test(match.code)) return [];
        const percent = typeof match.percent === 'number' ? match.percent : Number(match.percent);
        if (!Number.isFinite(percent)) return [];
        return [{ code: match.code, title: typeof match.title === 'string' ? match.title : '', percent }];
    });
    if (!matches.length) return undefined;
    return { kind: 'candidates', matches: matches.slice(0, 3), reason };
}

export function toPublicPortalJob(raw: Record<string, unknown>): JobsPortalJob {
    const listingSource = publicJobListingSource(raw.listingSource);
    const listingEvidence = publicListingEvidence(
        raw.quality_version === 'content-v1'
            ? {
                  sourceSeenAt: raw.last_seen_at,
                  descriptionCheckedAt: raw.description_checked_at,
                  checksVersion: raw.quality_version,
              }
            : raw.listingEvidence,
    );
    const assessment = publicSponsorshipAssessment(raw.sponsorship_assessment ?? raw.sponsorshipAssessment);
    const nested = raw.company;
    const company =
        nested && typeof nested === 'object' && !Array.isArray(nested)
            ? toPublicPortalCompany(nested as Record<string, unknown>)
            : undefined;

    // Descriptions are only present when a caller explicitly selected them (CAFY chat); list queries never select them.
    const description = pickNullableString(raw.description)?.trim() || null;
    const soc = jobsTableSocDisplay(raw) ?? socAlreadyShown(raw.soc);

    return {
        ...(listingSource ? { listingSource } : {}),
        ...(assessment ? { sponsorshipAssessment: assessment } : {}),
        ...(pickNullableString(raw.salary) ? { salary: pickNullableString(raw.salary) } : {}),
        ...(listingEvidence ? { listingEvidence } : {}),
        id: String(raw.id ?? ''),
        title: pickString(raw.title),
        url: pickString(raw.url),
        location: cleanPortalJobLocation(raw.location) || pickString(raw.location).trim(),
        ...(pickNullableString(raw.city)?.trim() ? { city: pickNullableString(raw.city)!.trim() } : {}),
        department: pickNullableString(raw.department) ?? undefined,
        level: pickNullableString(raw.level),
        sector: pickNullableString(raw.sector),
        jobType: pickNullableString(raw.job_type ?? raw.jobType),
        created_at: pickString(raw.created_at),
        company_id: pickNumber(raw.company_id),
        company,
        ...(description ? { description } : {}),
        ...(soc ? { soc } : {}),
        ...(raw.hasReported === true ? { hasReported: true } : {}),
        ...(raw.feedSegment === 'preferred' ||
        raw.feedSegment === 'secondary' ||
        raw.feedSegment === 'levelOnly' ||
        raw.feedSegment === 'remainder'
            ? { feedSegment: raw.feedSegment }
            : {}),
    };
}

export function toPublicPortalJobs(jobs: unknown[]): JobsPortalJob[] {
    return jobs
        .filter((j): j is Record<string, unknown> => !!j && typeof j === 'object' && !Array.isArray(j))
        .filter((job) => job.listingSource === undefined || Boolean(publicJobListingSource(job.listingSource)))
        .map(toPublicPortalJob)
        .filter(
            (job) =>
                !job.listingSource ||
                (job.listingSource.employerLicence === 'catalogue-match'
                    ? job.company?.licensed_sponsor === true
                    : job.company?.licensed_sponsor !== true),
        );
}

/** Free company overlay: only fields the UI renders (no JD / nested company). */
export function toFreeDirectoryJobs(jobs: unknown[]): JobsPortalJob[] {
    return toPublicPortalJobs(jobs).map((job) => ({
        id: job.id,
        title: job.title,
        url: job.url,
        location: job.location,
        level: job.level ?? null,
        jobType: job.jobType ?? null,
        sector: job.sector ?? null,
        ...(job.soc ? { soc: job.soc } : {}),
        ...(job.salary ? { salary: job.salary } : {}),
        company_id: job.company_id,
        created_at: job.created_at,
        ...(job.sponsorshipAssessment ? { sponsorshipAssessment: job.sponsorshipAssessment } : {}),
    }));
}

export function toPublicPortalCompanies(companies: unknown[]): PublicJobsPortalCompany[] {
    return companies
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c))
        .map(toPublicPortalCompany);
}

export function toDirectoryPortalCompany(raw: Record<string, unknown>, jobCount?: number): DirectoryPortalCompany {
    const company = toPublicPortalCompany(raw);
    const count =
        typeof jobCount === 'number' && Number.isFinite(jobCount) ? jobCount : pickNumber(raw.active_jobs_count);
    return {
        ...company,
        active_jobs_count: Math.max(0, Math.floor(count)),
    };
}
