/**
 * Server-controlled ResumeTool metered operations (reserve/refund API).
 */

export const RESUME_TOOL_OPERATIONS = ['analyse', 'optimise', 'import', 'pdf_download'] as const;

export type ResumeToolOperation = (typeof RESUME_TOOL_OPERATIONS)[number];

export function isResumeToolOperation(value: unknown): value is ResumeToolOperation {
    return typeof value === 'string' && (RESUME_TOOL_OPERATIONS as readonly string[]).includes(value);
}
