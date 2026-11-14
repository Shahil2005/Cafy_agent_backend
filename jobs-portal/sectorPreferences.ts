import { ALLOWED_SECTORS, type Sector } from './constants';

const ALLOWED_SECTOR_SET = new Set<string>(ALLOWED_SECTORS);

/** Legacy profile labels → current `jobs.sector` values. */
const LEGACY_SECTOR_ALIASES: Record<string, Sector> = {
    'Software Engineering & IT': 'Engineering (Software)',
    'Hardware & Electronics Engineering': 'Engineering (Hardware)',
    'Mechanical, Civil & Other Engineering': 'Engineering (Other)',
};

/**
 * Map a single raw string to an allowlisted sector, or null if invalid / unsafe.
 */
export function normalizeSectorName(raw: string): Sector | null {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 120) return null;
    if (ALLOWED_SECTOR_SET.has(trimmed)) {
        return trimmed as Sector;
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_SECTOR_ALIASES, trimmed)) {
        return LEGACY_SECTOR_ALIASES[trimmed as keyof typeof LEGACY_SECTOR_ALIASES];
    }
    return null;
}

/**
 * Keep only allowlisted sectors (deduped, stable order).
 */
export function sanitizeUserSectors(input: string[] | undefined | null): Sector[] {
    if (!input?.length) return [];
    const seen = new Set<Sector>();
    const out: Sector[] = [];
    for (const raw of input) {
        const sector = normalizeSectorName(String(raw));
        if (sector && !seen.has(sector)) {
            seen.add(sector);
            out.push(sector);
        }
    }
    return out;
}

/** PostgREST `in` / `not.in` list for `jobs.sector`. */
export function quoteSectorsForPostgrest(sectors: readonly string[]): string {
    return sectors.map((sector) => `"${sector.replace(/"/g, '')}"`).join(',');
}

/**
 * Strict sector match: rules `sector` column only (what users see on the card).
 * Prefer this for browse "preferred" so Other+embedding jobs cannot outrank real sector matches.
 */
export function buildStrictSectorMatchIn(sectors: readonly string[]): string {
    return `sector.in.(${quoteSectorsForPostgrest(sectors)})`;
}

/**
 * Hybrid sector match — mirrors CAFY-JOBS `mergeJobSector` at query time:
 *   1. Primary: `sector` IN prefs (rules / hybrid winner stored at ingest)
 *   2. Gap-fill: `sector_embedding` IN prefs only when `sector` is null or Other
 *
 * Do not run MiniLM online; both columns are written by CAFY-JOBS sync.
 * Browse preferred/secondary use strict match instead so gap-fill cannot rank first.
 */
export function buildHybridSectorMatchOr(sectors: readonly string[]): string {
    const list = quoteSectorsForPostgrest(sectors);
    return [
        `sector.in.(${list})`,
        `and(sector_embedding.in.(${list}),or(sector.is.null,sector.eq.Other))`,
    ].join(',');
}

/**
 * Other/null rows whose embedding matches prefs (soft sector signal).
 * Used as a tier *after* strict sector preferred, never mixed into it.
 */
export function buildSectorEmbeddingGapFillAnd(sectors: readonly string[]): string {
    const list = quoteSectorsForPostgrest(sectors);
    return `and(sector_embedding.in.(${list}),or(sector.is.null,sector.eq.Other))`;
}

/**
 * Remainder complement of hybrid preferred: keep rows that are not hybrid matches.
 * Used with `.not('sector','in',…)` already applied, or alone for null-sector pool.
 */
export function buildHybridSectorEmbeddingGapExcludeOr(sectors: readonly string[]): string {
    const list = quoteSectorsForPostgrest(sectors);
    // Keep row unless it is Other/null-sector with a preferred embedding (those belong in preferred).
    return [
        `sector.neq.Other`,
        `sector_embedding.is.null`,
        `sector_embedding.not.in.(${list})`,
    ].join(',');
}

export function buildNullSectorHybridExcludeOr(sectors: readonly string[]): string {
    const list = quoteSectorsForPostgrest(sectors);
    return `sector_embedding.is.null,sector_embedding.not.in.(${list})`;
}
