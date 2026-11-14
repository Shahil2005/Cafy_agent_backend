import { createHash } from 'node:crypto';
import { canonicalJobUrl } from './chatWebUrls';
import type { JobsPortalJob } from './types';

/** Prefer CAFY metadata for an identical apply URL or identical advert; interleave genuinely additional jobs. */
export function mergeChatJobSources(catalogue: JobsPortalJob[], web: JobsPortalJob[]): JobsPortalJob[] {
    const urls = new Set<string>();
    const adverts = new Set<string>();
    const identity = (job: JobsPortalJob): string =>
        createHash('sha256')
            .update(
                [
                    job.title,
                    job.company?.trading_name || '',
                    job.location,
                    (job.description || '').replace(/<[^>]*>/g, ' '),
                ]
                    .map((value) => value.toLowerCase().replace(/\s+/g, ' ').trim())
                    .join('\n'),
            )
            .digest('hex');
    const accept = (job: JobsPortalJob): boolean => {
        const url = canonicalJobUrl(job.url) || `id:${job.id}`;
        const advert = job.description?.trim() ? identity(job) : undefined;
        if (urls.has(url) || (advert && adverts.has(advert))) return false;
        urls.add(url);
        if (advert) adverts.add(advert);
        return true;
    };
    const database = catalogue.filter(accept);
    const additional = web.filter(accept);
    const merged: JobsPortalJob[] = [];
    for (let index = 0; index < Math.max(database.length, additional.length); index++) {
        if (database[index]) merged.push(database[index]!);
        if (additional[index]) merged.push(additional[index]!);
    }
    return merged;
}

export function webRequestFromMessage(message: string, includeWeb = false): { message: string; requested: boolean } {
    const patterns = [
        /\b(?:from|on|across)\s+(?:the\s+)?(?:web|internet)(?:\s+as well|\s+too)?\b/gi,
        /\b(?:include|search|check)\s+(?:the\s+)?(?:web|internet)(?:\s+(?:jobs|results))?(?:\s+as well|\s+too)?(?=\s*(?:$|[,.!?;])|\s+for\b)/gi,
    ];
    let text = message;
    let requested = includeWeb;
    for (const pattern of patterns) {
        if (pattern.test(text)) {
            requested = true;
            text = text.replace(pattern, ' ');
        }
    }
    return { message: text.replace(/\s+/g, ' ').trim() || 'same jobs', requested };
}
