export function classifyHttpError(status: number): { retryable: boolean; fatal: boolean } {
    if (status === 400 || status === 401 || status === 403 || status === 404) {
        return { retryable: false, fatal: true };
    }
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
        return { retryable: true, fatal: false };
    }
    return { retryable: false, fatal: false };
}

export function isNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const name = error.name;
    return (
        name === 'AbortError' ||
        name === 'TypeError' ||
        /fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(error.message)
    );
}

export function backoffMs(baseMs: number, attempt: number): number {
    const exponential = baseMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(exponential, 8000) + Math.floor(Math.random() * 500);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
