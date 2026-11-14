/**
 * Strict query contract for GET /api/jobs-portal/public-preview.
 *
 * Only preference filters are accepted. Anything that could widen the result
 * (page, offset, limit, q, role, where, companyId, …) is rejected with 400 —
 * logged-out visitors can never paginate, search, or change the cap.
 */
import { z } from 'zod';
import { ALLOWED_JOB_TYPES, ALLOWED_SECTORS, JOB_CATALOG_LEVELS } from '../constants';
import type { JobsCatalogCountry } from '../jobsCatalog';

/** Hard cap on the raw query string — bounds parsing work before Zod runs. */
export const PUBLIC_PREVIEW_MAX_QUERY_LENGTH = 1024;

function csvList(allowed: readonly string[], max: number) {
    const allowedSet = new Set(allowed);
    return z
        .string()
        .max(600)
        .optional()
        .transform((raw) =>
            raw
                ? [...new Set(raw.split(',').map((v) => v.trim()).filter(Boolean))]
                : []
        )
        .refine((values) => values.length <= max, { message: 'Too many values' })
        .refine((values) => values.every((v) => allowedSet.has(v)), { message: 'Unknown value' });
}

const publicPreviewQuerySchema = z
    .object({
        country: z.enum(['uk', 'ireland']).optional().default('uk'),
        sectors: csvList(ALLOWED_SECTORS, 5),
        levels: csvList(JOB_CATALOG_LEVELS, 4),
        jobTypes: csvList(ALLOWED_JOB_TYPES, 5),
    })
    .strict();

export interface PublicPreviewQuery {
    country: JobsCatalogCountry;
    sectors: string[];
    levels: string[];
    jobTypes: string[];
}

export function parsePublicPreviewQuery(
    rawQuery: unknown,
    originalUrl: string
): PublicPreviewQuery | null {
    if (originalUrl.length > PUBLIC_PREVIEW_MAX_QUERY_LENGTH) return null;
    const parsed = publicPreviewQuerySchema.safeParse(rawQuery);
    return parsed.success ? parsed.data : null;
}

/** Order-insensitive key so equivalent preference sets share one cache entry. */
export function publicPreviewCacheKey(query: PublicPreviewQuery): string {
    const sorted = (values: string[]) => [...values].sort().join(',');
    return [query.country, sorted(query.sectors), sorted(query.levels), sorted(query.jobTypes)].join('|');
}

// ---------------------------------------------------------------------------
// UK part-time preview: all-UK only. Location, search and paging stay behind
// login, so the endpoint accepts no parameters at all (any param → 400).
// ---------------------------------------------------------------------------

const publicPartTimeQuerySchema = z.object({}).strict();

export function isValidPublicPartTimeQuery(rawQuery: unknown, originalUrl: string): boolean {
    if (originalUrl.length > PUBLIC_PREVIEW_MAX_QUERY_LENGTH) return false;
    return publicPartTimeQuerySchema.safeParse(rawQuery).success;
}
