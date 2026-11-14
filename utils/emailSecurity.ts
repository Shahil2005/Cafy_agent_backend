const MAX_URL_LENGTH = 2048;
const DANGEROUS_PROTOCOLS = ['javascript:', 'data:', 'file:', 'vbscript:', 'about:'];

/**
 * Returns a normalized http(s) URL or null if invalid/unsafe.
 */
export function sanitizeHttpUrl(url: unknown): string | null {
    if (url === null || url === undefined) {
        return null;
    }
    if (typeof url !== 'string') {
        return null;
    }

    const trimmed = url.trim();
    if (!trimmed || trimmed.length > MAX_URL_LENGTH) {
        return null;
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }

    const lower = parsed.href.toLowerCase();
    if (DANGEROUS_PROTOCOLS.some((p) => lower.startsWith(p))) {
        return null;
    }

    return parsed.href;
}
