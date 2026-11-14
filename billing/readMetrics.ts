/**
 * Optional billing-status read metrics (Phase 0).
 * Enable with BILLING_READ_METRICS=1, or always log outside production.
 */
export function logBillingStatusReads(params: {
    uid: string;
    userDocReads: number;
    cacheHit?: boolean;
    syncStripe?: boolean;
}): void {
    const enabled =
        process.env.BILLING_READ_METRICS === '1' || process.env.NODE_ENV !== 'production';
    if (!enabled) return;
    const uidHint = params.uid.length > 6 ? `${params.uid.slice(0, 6)}…` : params.uid;
    console.log(
        `[billing-reads] uid=${uidHint} userDocReads=${params.userDocReads}` +
            ` cacheHit=${params.cacheHit === true}` +
            ` sync=${params.syncStripe === true}`
    );
}
