/**
 * jobPortalConstants.ts (backend)
 *
 * Shared allowlists for Jobs Portal preferences validation.
 * All input is validated against these before being written to Firestore.
 * Mirrors Product-Site/src/data/jobPortalConstants.ts — keep in sync.
 * Job browse matching uses Supabase `jobs.sector` (same labels as below).
 */

/**
 * Distinct non-empty values in Supabase `jobs.level` (production catalog).
 * Keep in sync with CAFY-JOBS `ALLOWED_JOB_LEVELS`.
 */
export const JOB_CATALOG_LEVELS = [
    'Entry Level',
    'Junior',
    'Mid Level',
    'Senior',
] as const;

export type JobCatalogLevel = (typeof JOB_CATALOG_LEVELS)[number];

/** Profile experience levels — same values as `jobs.level`. */
export const ALLOWED_EXPERIENCE_LEVELS = JOB_CATALOG_LEVELS;

export type ExperienceLevel = JobCatalogLevel;

/**
 * Employment type — mirrors CAFY-JOBS `ALLOWED_JOB_TYPES` / `jobs.job_type`.
 * Keep in sync with Product-Site and CAFY-JOBS.
 */
export const ALLOWED_JOB_TYPES = [
    'Full-time',
    'Part-time',
    'Contract',
    'Internship',
    'Placement scheme',
] as const;

export type JobType = (typeof ALLOWED_JOB_TYPES)[number];

/** Distinct non-empty values in Supabase `jobs.sector` (synced with CAFY-JOBS, 25 sectors). */
export const ALLOWED_SECTORS = [
    'Business & Strategy',
    'Construction & Infrastructure',
    'Customer Success',
    'Data',
    'Design',
    'Engineering (Hardware)',
    'Engineering (Other)',
    'Engineering (Software)',
    'Finance',
    'Healthcare',
    'Healthcare & Social Care',
    'HR / People',
    'Legal',
    'Logistics & Transport',
    'Marketing & PR',
    'Media & Journalism',
    'Operations',
    'Other',
    'Pharmaceutical',
    'Product Management',
    'Project Management',
    'Research (Non-technical)',
    'Research (Technical)',
    'Retail & Hospitality',
    'Sales & Partnerships',
] as const;

export type Sector = typeof ALLOWED_SECTORS[number];

export interface JobPortalPreferences {
    sectors: Sector[];
    updatedAt: string;
}

/** Jobs feed page size (Premium pagination). */
export const JOBS_PAGE_SIZE = 10;
export const FREE_BROWSE_JOBS_LIMIT = 10;
export const FREE_SEARCH_JOBS_LIMIT = 1;

/** Companies directory page size (Premium pagination). */
export const COMPANIES_PAGE_SIZE = 10;
export const FREE_COMPANIES_LIMIT = 10;
/** Free users see one preview role per company. */
export const FREE_COMPANY_JOBS_LIMIT = 1;

/** Max length for jobs search query (`q`). */
export const JOBS_SEARCH_QUERY_MAX_LENGTH = 100;

/** Max companies matched by trading_name per search request. */
export const JOBS_COMPANY_NAME_SEARCH_LIMIT = 200;

/** Client-side count race timeout (Postgres also enforces statement_timeout). */
export const SEARCH_COUNT_TIMEOUT_MS = 8_000;

/** UK sponsor register — paginated browse (must match Product-Site displayLimit). */
export const SPONSORSHIP_PAGE_SIZE = 12;
export const SPONSORSHIP_SEARCH_MAX_LENGTH = 100;
export const COMPANIES_HOUSE_SEARCH_MAX_LENGTH = 100;
