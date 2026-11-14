/**
 * Server-controlled AI operation types for /api/ai/generate.
 * Billing and limits use operation only — never trust client mime/usageType alone.
 */

export const AI_OPERATIONS = [
    'comm_cover_letter',
    'comm_email',
    'career_path_analysis',
    'linkedin_optimizer',
    'autofill_profile',
    'autofill_fill',
    'jobs_search_chat',
    'jobs_cv_profile',
    'jobs_cv_fit',
    'jobs_cv_roles',
    'jobs_web_discovery',
    'agent_turn',
    'agent_cv_profile',
    'agent_job_fit',
    'agent_cv_tailor',
] as const;

export type AiOperation = (typeof AI_OPERATIONS)[number];

const COMM_BILLABLE: ReadonlySet<AiOperation> = new Set([
    'comm_cover_letter',
    'comm_email',
]);

export function isAiOperation(value: unknown): value is AiOperation {
    return (
        typeof value === 'string' &&
        (AI_OPERATIONS as readonly string[]).includes(value)
    );
}

export function isCommBillableOperation(operation: AiOperation): boolean {
    return COMM_BILLABLE.has(operation);
}

/** Resolve operation from body. Requires `operation` for all clients. */
export function resolveAiOperation(body: {
    operation?: unknown;
}): AiOperation | null {
    if (isAiOperation(body.operation)) {
        return body.operation;
    }

    return null;
}
