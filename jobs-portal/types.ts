import type { JobsTableSoc } from './socDisplay';

/** Browse ranking: sector+level → sector only → level only → rest */
export type BrowseFeedSegment = 'preferred' | 'secondary' | 'levelOnly' | 'remainder';

export interface JobListingSource {
    kind: 'web';
    provider: 'jsearch' | 'employer-sites';
    publisher?: string;
    retrievedAt: string;
    postedAt?: string;
    expiresAt?: string;
    availability: 'unverified' | 'source-listed';
    employerLicence: 'unknown' | 'catalogue-match';
}

export interface JobsPortalJob {
    listingSource?: JobListingSource;
    listingEvidence?: { sourceSeenAt: string; descriptionCheckedAt: string; checksVersion: 'content-v1' };
    sponsorshipAssessment?: import('./sponsorshipProjection').PublicSponsorshipAssessment;
    id: string;
    title: string;
    url: string;
    location: string;
    /** Official UK city when present (part-time catalog). */
    city?: string | null;
    department?: string;
    level?: string | null;
    sector?: string | null;
    /** Employment type from catalog (`jobs.job_type`) */
    jobType?: string | null;
    /**
     * UK jobs table only. High confidence is one code.
     * Low confidence is up to three codes at 40% or more.
     * Stored alternatives are not sent when confidence is high.
     */
    soc?: JobsTableSoc;
    /** Advert pay text, UK jobs table only. */
    salary?: string | null;
    /** Plain-text job description from the catalog */
    description?: string | null;
    created_at: string;
    company_id: number;
    company?: PublicJobsPortalCompany;
    hasReported?: boolean;
    /** Browse mode: matches sector prefs vs rest of catalog */
    feedSegment?: BrowseFeedSegment;
}

export interface JobsPortalCompany {
    id: number;
    trading_name: string;
    companies_house_name: string | null;
    url: string | null;
    url_linkedin: string | null;
    url_favicon: string | null;
    description: string | null;
    estimated_num_employees_label: string | null;
    /** UK Home Office Worker / Temporary Worker licence */
    licensed_sponsor: boolean;
    /** Ireland DETE employment-permits register employer */
    ireland_permit_employer: boolean;
    active_jobs_count: number;
    cos_used_count_2025: number | null;
    open_to_sponsorship: number | null;
    show_recently_added_badge: boolean;
    added_to_register: string | null;
}

/**
 * Client-facing company shape — omits internal counters not shown in the UI.
 * `description` is always populated (DB text or a generated fallback).
 */
export type PublicJobsPortalCompany = Omit<JobsPortalCompany, 'active_jobs_count' | 'description'> & {
    description: string;
};

/** Directory + company profile — includes live job count for the selected catalog. */
export type DirectoryPortalCompany = PublicJobsPortalCompany & {
    active_jobs_count: number;
};
