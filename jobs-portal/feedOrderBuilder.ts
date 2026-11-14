import type { SupabaseClient } from '@supabase/supabase-js';
import {
    fetchAllBrowseJobIdsForDims,
    type BrowsePreferenceFilters,
    type BrowseJobIdRow,
    type PrefMatchDims,
} from './browseFeed';
import type { BrowseFilterOpts } from './feedOrderCache';
import { jobsTableForCountry, type JobsTableName } from './jobsCatalog';

export interface BuiltFeedOrder {
    /** Collapsed for API/cache compat: SLT+SL */
    preferredIds: string[];
    /** ST+S */
    secondaryIds: string[];
    /** LT+L */
    levelOnlyIds: string[];
    /** type + remainder */
    remainderIds: string[];
    orderedIds: string[];
    preferredIdSet: Set<string>;
    secondaryIdSet: Set<string>;
    levelOnlyIdSet: Set<string>;
}

const EMPTY_SECTOR_LEVEL_FILTERS: BrowsePreferenceFilters = {
    sectors: null,
    jobLevels: null,
    jobTypes: null,
};

/** Deterministic within-tier order: newest first, then id. No shuffle / interleave. */
function stableOrderRows(rows: BrowseJobIdRow[]): BrowseJobIdRow[] {
    return [...rows].sort((a, b) => {
        const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (aCreated !== bCreated) return bCreated - aCreated;
        return String(b.id).localeCompare(String(a.id));
    });
}

function exclusiveIds(
    rows: BrowseJobIdRow[],
    claimed: Set<string>
): { ids: string[]; nextClaimed: Set<string> } {
    const ordered = stableOrderRows(rows);
    const ids: string[] = [];
    for (const row of ordered) {
        if (claimed.has(row.id)) continue;
        ids.push(row.id);
        claimed.add(row.id);
    }
    return { ids, nextClaimed: claimed };
}

/**
 * Preference order (highest first, exclusive):
 * 1 sector+level+type → 2 sector+type → 3 sector+level → 4 sector
 * → 5 level+type → 6 level → 7 type → 8 remainder
 */
export async function buildPreferenceFeedOrder(
    db: SupabaseClient,
    filters: BrowsePreferenceFilters,
    filterOpts: BrowseFilterOpts,
    _cacheFingerprint: string,
    jobsTable: JobsTableName = jobsTableForCountry('uk')
): Promise<BuiltFeedOrder> {
    const hasS = Boolean(filters.sectors?.length);
    const hasL = Boolean(filters.jobLevels?.length);
    const hasT = Boolean(filters.jobTypes?.length);

    const dimsList: Array<{ key: string; dims: PrefMatchDims | 'all' }> = [];
    if (hasS && hasL && hasT) dimsList.push({ key: 'slt', dims: { sectors: true, levels: true, types: true } });
    if (hasS && hasT) dimsList.push({ key: 'st', dims: { sectors: true, levels: false, types: true } });
    if (hasS && hasL) dimsList.push({ key: 'sl', dims: { sectors: true, levels: true, types: false } });
    if (hasS) dimsList.push({ key: 's', dims: { sectors: true, levels: false, types: false } });
    if (hasL && hasT) dimsList.push({ key: 'lt', dims: { sectors: false, levels: true, types: true } });
    if (hasL) dimsList.push({ key: 'l', dims: { sectors: false, levels: true, types: false } });
    if (hasT) dimsList.push({ key: 't', dims: { sectors: false, levels: false, types: true } });
    dimsList.push({ key: 'all', dims: 'all' });

    const fetched = await Promise.all(
        dimsList.map(async ({ key, dims }) => {
            if (dims === 'all') {
                const rows = await fetchAllBrowseJobIdsForDims(
                    db,
                    { sectors: false, levels: false, types: false },
                    EMPTY_SECTOR_LEVEL_FILTERS,
                    filterOpts,
                    jobsTable
                );
                return { key, rows };
            }
            const rows = await fetchAllBrowseJobIdsForDims(db, dims, filters, filterOpts, jobsTable);
            return { key, rows };
        })
    );

    const byKey = new Map(fetched.map((f) => [f.key, f.rows]));
    let claimed = new Set<string>();

    const take = (key: string): string[] => {
        const rows = byKey.get(key) || [];
        const { ids, nextClaimed } = exclusiveIds(rows, claimed);
        claimed = nextClaimed;
        return ids;
    };

    const slt = hasS && hasL && hasT ? take('slt') : [];
    const st = hasS && hasT ? take('st') : [];
    const sl = hasS && hasL ? take('sl') : [];
    const s = hasS ? take('s') : [];
    const lt = hasL && hasT ? take('lt') : [];
    const l = hasL ? take('l') : [];
    const t = hasT ? take('t') : [];
    const remainder = take('all');

    // Segment buckets must concatenate to the exclusive tier order (cache rebuild).
    const preferredIds = [...slt, ...st];
    const secondaryIds = [...sl, ...s];
    const levelOnlyIds = [...lt, ...l];
    const remainderIds = [...t, ...remainder];
    const orderedIds = [...preferredIds, ...secondaryIds, ...levelOnlyIds, ...remainderIds];

    return {
        preferredIds,
        secondaryIds,
        levelOnlyIds,
        remainderIds,
        orderedIds,
        preferredIdSet: new Set(preferredIds),
        secondaryIdSet: new Set(secondaryIds),
        levelOnlyIdSet: new Set(levelOnlyIds),
    };
}

export async function buildTwoPhaseFeedOrder(
    db: SupabaseClient,
    sectors: import('./constants').Sector[],
    filterOpts: BrowseFilterOpts,
    cacheFingerprint: string,
    jobsTable: JobsTableName = jobsTableForCountry('uk')
): Promise<BuiltFeedOrder> {
    return buildPreferenceFeedOrder(
        db,
        { sectors, jobLevels: null, jobTypes: null },
        filterOpts,
        cacheFingerprint,
        jobsTable
    );
}

export async function buildSinglePhaseFeedOrder(
    db: SupabaseClient,
    filterOpts: BrowseFilterOpts,
    _cacheFingerprint: string,
    jobsTable: JobsTableName = jobsTableForCountry('uk')
): Promise<BuiltFeedOrder> {
    const allRows = await fetchAllBrowseJobIdsForDims(
        db,
        { sectors: false, levels: false, types: false },
        EMPTY_SECTOR_LEVEL_FILTERS,
        filterOpts,
        jobsTable
    );
    const orderedIds = stableOrderRows(allRows).map((r) => r.id);

    return {
        preferredIds: [],
        secondaryIds: [],
        levelOnlyIds: [],
        remainderIds: orderedIds,
        orderedIds,
        preferredIdSet: new Set(),
        secondaryIdSet: new Set(),
        levelOnlyIdSet: new Set(),
    };
}

export type { BrowseFilterOpts };
