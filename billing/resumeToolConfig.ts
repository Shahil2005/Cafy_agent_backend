/**
 * ResumeTool usage limits — env only, never trust client.
 */

export type ResumeToolTier = 'free' | 'premium_monthly' | 'premium_quarterly';

export interface ResumeToolLimits {
    ai: number | null;
    import: number | null;
    pdfDownload: number | null;
}

export function isResumeToolBillingEnabled(): boolean {
    return process.env.RESUME_TOOL_BILLING_ENABLED === 'true';
}

function parseLimit(raw: string | undefined, fallback: number): number | null {
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === '-1' || trimmed === 'unlimited') {
        return null;
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0) {
        return fallback;
    }
    return n;
}

function isPaidTierUnlimited(tier: ResumeToolTier): boolean {
    if (tier === 'premium_quarterly') {
        return process.env.RESUME_QUARTERLY_UNLIMITED !== 'false';
    }
    if (tier === 'premium_monthly') {
        // £18/month plan: unlimited for the billing period (default). Set false to use capped limits.
        return process.env.RESUME_MONTHLY_UNLIMITED !== 'false';
    }
    return false;
}

export function getResumeToolLimits(tier: ResumeToolTier): ResumeToolLimits {
    if (isPaidTierUnlimited(tier)) {
        return { ai: null, import: null, pdfDownload: null };
    }

    if (tier === 'premium_monthly') {
        return {
            ai: parseLimit(process.env.RESUME_MONTHLY_AI_LIMIT, 20),
            import: parseLimit(process.env.RESUME_MONTHLY_IMPORT_LIMIT, 10),
            pdfDownload: parseLimit(process.env.RESUME_MONTHLY_PDF_DOWNLOAD_LIMIT, -1),
        };
    }

    return {
        ai: parseLimit(process.env.RESUME_FREE_AI_LIMIT, 2),
        import: parseLimit(process.env.RESUME_FREE_IMPORT_LIMIT, 1),
        pdfDownload: parseLimit(process.env.RESUME_FREE_PDF_DOWNLOAD_LIMIT, 5),
    };
}
