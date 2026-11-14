/**
 * Anonymous response shape — explicit field allowlist.
 *
 * Never spread a source object here: new DB columns must not leak to logged-out
 * visitors by default. The job apply URL and the company website (which falls
 * back to `careers_url` in toPublicPortalCompany) are intentionally omitted —
 * applying requires an account.
 */
import type { JobsPortalJob } from '../types';
import { publicListingEvidence } from '../publicResponse';

const MAX_COMPANY_DESCRIPTION_CHARS = 1500;

export interface AnonPreviewCompany {
    id: number;
    trading_name: string;
    url_linkedin: string | null;
    url_favicon: string | null;
    description: string | null;
    estimated_num_employees_label: string | null;
    licensed_sponsor: boolean;
    ireland_permit_employer: boolean;
    cos_used_count_2025: number | null;
    show_recently_added_badge: boolean;
}

export interface AnonPreviewJob {
    listingEvidence?: JobsPortalJob['listingEvidence'];
    salary?: string | null;
    sponsorshipAssessment?: JobsPortalJob['sponsorshipAssessment'];
    id: string;
    title: string;
    location: string;
    /** Official UK city (part-time catalog). */
    city: string | null;
    department: string | null;
    level: string | null;
    sector: string | null;
    jobType: string | null;
    soc: JobsPortalJob['soc'] | null;
    created_at: string;
    company_id: number;
    description: string | null;
    company: AnonPreviewCompany | null;
}

export interface PublicPreviewPayload {
    jobs: AnonPreviewJob[];
    previewLimit: number;
    hasMore: boolean;
    /** Rounded-down count label (e.g. "1,200+") — exact catalog size is not exposed. */
    moreLabel: string | null;
}

function safeHttpUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function capText(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
}

function nullableString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toAnonPreviewCompany(raw: JobsPortalJob['company']): AnonPreviewCompany | null {
    if (!raw || typeof raw !== 'object') return null;
    const company = raw as unknown as Record<string, unknown>;
    return {
        id: Number(company.id) || 0,
        trading_name: nullableString(company.trading_name) ?? 'Unknown Company',
        url_linkedin: safeHttpUrl(company.url_linkedin),
        url_favicon: safeHttpUrl(company.url_favicon),
        description: capText(company.description, MAX_COMPANY_DESCRIPTION_CHARS),
        estimated_num_employees_label: nullableString(company.estimated_num_employees_label),
        licensed_sponsor: company.licensed_sponsor === true,
        ireland_permit_employer: company.ireland_permit_employer === true,
        cos_used_count_2025:
            typeof company.cos_used_count_2025 === 'number' && Number.isFinite(company.cos_used_count_2025)
                ? company.cos_used_count_2025
                : null,
        show_recently_added_badge: company.show_recently_added_badge === true,
    };
}

export function toAnonPreviewJob(job: JobsPortalJob): AnonPreviewJob {
    const raw = job as unknown as Record<string, unknown>;
    const listingEvidence = publicListingEvidence(job.listingEvidence);
    return {
        ...(listingEvidence ? { listingEvidence } : {}),
        ...(job.salary ? { salary:capText(job.salary,500) } : {}),
        id: String(raw.id ?? ''),
        title: nullableString(raw.title) ?? '',
        location: nullableString(raw.location) ?? '',
        city: nullableString(raw.city),
        department: nullableString(raw.department),
        level: nullableString(raw.level),
        sector: nullableString(raw.sector),
        jobType: nullableString(raw.jobType),
        soc: job.soc ?? null,
        created_at: nullableString(raw.created_at) ?? '',
        company_id: Number(raw.company_id) || 0,
        // Job descriptions aren't sent on any plan
        description: null,
        company: toAnonPreviewCompany(job.company),
        ...(job.sponsorshipAssessment ? { sponsorshipAssessment: job.sponsorshipAssessment } : {}),
    };
}

/** Round down so the label is always truthful but never exact. */
export function remainingJobsLabel(totalCount: number, shown: number): string | null {
    const remaining = Math.max(0, totalCount - shown);
    if (remaining <= 0) return null;
    const step = remaining < 100 ? 10 : remaining < 1000 ? 50 : 100;
    const rounded = Math.floor(remaining / step) * step;
    if (rounded <= 0) return `${remaining}`;
    return `${rounded.toLocaleString('en-GB')}+`;
}
