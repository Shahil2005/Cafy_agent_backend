import { captureServerWarning } from '../lib/observability/sentry';

const FALLBACK_REPORT_INTERVAL_MS = 60 * 60 * 1000;
const lastFallbackReportAt = new Map<string, number>();

export function reportSearchRpcFallback(rpc: string, message: string): void {
    console.warn(`[search] RPC ${rpc} unavailable, falling back to ILIKE:`, message);

    const now = Date.now();
    const last = lastFallbackReportAt.get(rpc) ?? 0;
    if (now - last < FALLBACK_REPORT_INTERVAL_MS) {
        return;
    }
    lastFallbackReportAt.set(rpc, now);

    captureServerWarning(`Jobs search RPC fallback: ${rpc}`, {
        tags: { area: 'jobs-portal', search_mode: 'ilike_fallback', rpc },
        extra: { message },
    });
}

export function reportSearchCountTimeout(qTerm: string, timeoutMs: number): void {
    console.warn(`[search] search_jobs_count timed out after ${timeoutMs}ms for query length ${qTerm.length}`);

    captureServerWarning('Jobs search count query timed out', {
        tags: { area: 'jobs-portal', search_mode: 'count_timeout' },
        extra: { queryLength: qTerm.length, timeoutMs },
    });
}
