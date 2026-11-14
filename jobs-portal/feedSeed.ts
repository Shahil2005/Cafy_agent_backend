import { createHash } from 'crypto';
import type { Sector } from './constants';
import { JOBS_SEARCH_QUERY_MAX_LENGTH } from './constants';

export function preferencesFingerprint(sectors: readonly Sector[]): string {
    const normalized = [...sectors].map((s) => s.trim()).sort().join('|');
    return createHash('sha256').update(normalized).digest('hex');
}

export function experienceLevelsFingerprint(levels: readonly string[]): string {
    const normalized = [...levels].map((l) => l.trim()).sort().join('|');
    return createHash('sha256').update(normalized).digest('hex');
}

export function jobTypesFingerprint(jobTypes: readonly string[]): string {
    const normalized = [...jobTypes].map((t) => t.trim()).sort().join('|');
    return createHash('sha256').update(normalized).digest('hex');
}

/** Deterministic shuffle seed — no storage. Same user + same preferences → same order on reload. */
export function deriveFeedShuffleSeed(
    uid: string,
    sectors: readonly Sector[],
    experienceLevels: readonly string[] = [],
    catalogCountry: string = 'uk',
    jobTypes: readonly string[] = []
): string {
    const sectorFp = preferencesFingerprint(sectors);
    const levelFp = experienceLevelsFingerprint(experienceLevels);
    const jobTypeFp = jobTypesFingerprint(jobTypes);
    return createHash('sha256')
        .update(`${uid}:${catalogCountry}:${sectorFp}:${levelFp}:${jobTypeFp}`)
        .digest('hex');
}

export function normalizeSearchTerm(q: string): string {
    return q.trim().toLowerCase().slice(0, JOBS_SEARCH_QUERY_MAX_LENGTH);
}

/** Stable shuffle per user + search query (preferences ignored in search). */
export function deriveSearchShuffleSeed(uid: string, qTerm: string): string {
    const normalized = normalizeSearchTerm(qTerm);
    return createHash('sha256').update(`${uid}:search:${normalized}`).digest('hex');
}

/** Stable shuffle per user + part-time filters (city / search). */
export function derivePartTimeShuffleSeed(
    uid: string,
    filters: { city?: string; role?: string; where?: string } = {}
): string {
    const city = (filters.city || '').trim().toLowerCase();
    const role = normalizeSearchTerm(filters.role || '');
    const where = normalizeSearchTerm(filters.where || '');
    return createHash('sha256')
        .update(`${uid}:part-time:${city}:${role}:${where}`)
        .digest('hex');
}
