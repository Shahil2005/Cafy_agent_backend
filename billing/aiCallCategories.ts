/**
 * Categories for per-user AI call logs (`users/{uid}/aiCalls`).
 * Used by Product-Site, Chrome extension, and ResumeTool.
 */

export const AI_CALL_CATEGORIES = [
    'comm_cover_letter',
    'comm_email',
    'extension_cover_letter',
    'extension_job_analysis',
    'extension_autofill',
    'resume_analyse',
    'resume_smart_opt',
    'resume_optimise',
    'resume_import',
    'resume_compare',
    'career_path_analysis',
    'jobs_search_chat',
    'jobs_cv_profile',
    'jobs_web_discovery',
] as const;

export type AiCallCategory = (typeof AI_CALL_CATEGORIES)[number];

export const AI_CALL_SOURCES = [
    'product-site',
    'resume-tool',
    'extension',
] as const;

export type AiCallSource = (typeof AI_CALL_SOURCES)[number];

export function isAiCallCategory(value: unknown): value is AiCallCategory {
    return (
        typeof value === 'string' &&
        (AI_CALL_CATEGORIES as readonly string[]).includes(value)
    );
}

export function isAiCallSource(value: unknown): value is AiCallSource {
    return (
        typeof value === 'string' &&
        (AI_CALL_SOURCES as readonly string[]).includes(value)
    );
}

/** Human-readable labels for dashboards and billing status. */
export const AI_CALL_CATEGORY_LABELS: Record<AiCallCategory, string> = {
    comm_cover_letter: 'Cover letter',
    comm_email: 'Email',
    extension_cover_letter: 'Extension cover letter',
    extension_job_analysis: 'Extension job analysis',
    extension_autofill: 'Extension autofill',
    resume_analyse: 'Resume analyse',
    resume_smart_opt: 'Smart optimization',
    resume_optimise: 'Auto tailor',
    resume_import: 'Resume import',
    resume_compare: 'Resume compare',
    career_path_analysis: 'Career path analysis',
    jobs_search_chat: 'Job search chat',
    jobs_cv_profile: 'CV matching profile',
    jobs_web_discovery: 'Live web job research',
};

export type AiCallCounts = Record<AiCallCategory, number>;

export function emptyAiCallCounts(): AiCallCounts {
    return Object.fromEntries(
        AI_CALL_CATEGORIES.map((c) => [c, 0]),
    ) as AiCallCounts;
}

export function parseAiCallCounts(raw: unknown): AiCallCounts {
    const counts = emptyAiCallCounts();
    if (!raw || typeof raw !== 'object') return counts;
    const data = raw as Record<string, unknown>;
    for (const category of AI_CALL_CATEGORIES) {
        const value = data[category];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            counts[category] = value;
        }
    }
    return counts;
}
