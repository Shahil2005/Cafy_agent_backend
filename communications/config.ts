export function isCommHistoryEnabled(): boolean {
    return process.env.COMM_HISTORY_ENABLED !== 'false';
}

export function getFreeCommHistoryLimit(): number {
    const n = parseInt(process.env.FREE_COMM_HISTORY_LIMIT || '10', 10);
    return Number.isFinite(n) && n >= 0 ? n : 10;
}

export function getPremiumCommHistoryCap(): number {
    const n = parseInt(process.env.PREMIUM_COMM_HISTORY_CAP || '500', 10);
    return Number.isFinite(n) && n >= 0 ? n : 500;
}
