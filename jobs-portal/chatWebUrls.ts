import { isIP } from 'node:net';

/** Preserve job-ID parameters and meaningful fragments; remove only recognised tracking. */
export function canonicalJobUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    // Apply links are displayed, never fetched. Still reject local destinations,
    // literal IP addresses and credentials rather than presenting unsafe links.
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.port && url.port !== '443') ||
        !host.includes('.') ||
        isIP(host.replace(/^\[|\]$/g, '')) ||
        /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(host) ||
        /(?:^|\.)(?:localhost\.localdomain|home\.arpa)$/.test(host)
    )
        return null;
    for (const key of [...url.searchParams.keys()]) {
        if (
            /^(?:utm_.+|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid|igshid|_ga|_gl)$/i.test(key) ||
            (/^(?:ref|referrer)$/i.test(key) &&
                /^(?:linkedin|indeed|glassdoor|jsearch|google|facebook|twitter|jobboard)$/i.test(
                    url.searchParams.get(key) || '',
                ))
        )
            url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
}
