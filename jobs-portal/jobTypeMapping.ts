import { ALLOWED_JOB_TYPES, type JobType } from './constants';

const ALLOWED_JOB_TYPE_SET = new Set<string>(ALLOWED_JOB_TYPES);

/** Legacy profile labels → catalog `jobs.job_type` values. */
const LEGACY_JOB_TYPE_ALIASES: Record<string, JobType> = {
    Freelance: 'Contract',
};

/**
 * Map a single raw string to an allowlisted job type, or null if invalid.
 */
export function normalizeJobType(raw: string): JobType | null {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 80) return null;
    if (ALLOWED_JOB_TYPE_SET.has(trimmed)) {
        return trimmed as JobType;
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_JOB_TYPE_ALIASES, trimmed)) {
        return LEGACY_JOB_TYPE_ALIASES[trimmed];
    }
    return null;
}

/**
 * Keep only allowlisted job types (deduped, stable order). Freelance → Contract.
 */
export function sanitizeUserJobTypes(input: string[] | undefined | null): JobType[] {
    if (!input?.length) return [];
    const seen = new Set<JobType>();
    const out: JobType[] = [];
    for (const raw of input) {
        const jobType = normalizeJobType(String(raw));
        if (jobType && !seen.has(jobType)) {
            seen.add(jobType);
            out.push(jobType);
        }
    }
    return out;
}
