import fs from 'fs';
import path from 'path';
import { SPONSORSHIP_PAGE_SIZE } from './constants';

const MERGED_JSON_CANDIDATES = [
    path.resolve(__dirname, '../../data/ireland-employment-permits-merged.json'),
    path.resolve(__dirname, '../data/ireland-employment-permits-merged.json'),
    path.resolve(process.cwd(), 'data/ireland-employment-permits-merged.json'),
];

export const IRELAND_PERMIT_YEARS = ['2020', '2021', '2022', '2023', '2024', '2025', '2026'] as const;
export type IrelandPermitYear = (typeof IRELAND_PERMIT_YEARS)[number];

/** DETE spreadsheet aggregate labels — not real employers. */
const IRELAND_SUMMARY_EMPLOYER_NAMES = new Set([
    'total',
    'grand total',
    'overall total',
    'totals',
]);

export function isIrelandSummaryEmployerName(name: string): boolean {
    const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
    return IRELAND_SUMMARY_EMPLOYER_NAMES.has(normalized);
}

/** Major Irish cities — longest names first to avoid partial matches. */
const IRELAND_CITIES = [
    'Drogheda',
    'Dundalk',
    'Waterford',
    'Limerick',
    'Galway',
    'Kilkenny',
    'Athlone',
    'Tralee',
    'Ennis',
    'Navan',
    'Sligo',
    'Wexford',
    'Bray',
    'Dublin',
    'Cork',
] as const;

export type IrelandCity = (typeof IRELAND_CITIES)[number];

interface MergedEmployerJson {
    employerName: string;
    permitsByYear: Record<string, number>;
    permitsJan: number;
    permitsFeb: number;
    permitsMar: number;
    permitsApr: number;
    permitsMay: number;
    permitsJun: number;
    permitsJul?: number;
    totalPermits: number;
}

interface IrelandEmployerRecord {
    employerName: string;
    city: string | null;
    permitsByYear: Record<IrelandPermitYear, number>;
    permitsJan: number;
    permitsFeb: number;
    permitsMar: number;
    permitsApr: number;
    permitsMay: number;
    permitsJun: number;
    permitsJul: number;
    totalPermits: number;
    _nameLower: string;
    _cityLower: string | null;
}

export interface PermitRangeDef {
    id: string;
    label: string;
    min: number;
    max: number;
}

/**
 * Permit-count buckets.
 * When year filters are active, volume is measured against the sum of permits
 * in the selected year(s). Otherwise it uses lifetime total (2020–2026).
 */
export const IRELAND_PERMIT_RANGES: PermitRangeDef[] = [
    { id: '1-10', label: '1–10 permits', min: 1, max: 10 },
    { id: '11-50', label: '11–50 permits', min: 11, max: 50 },
    { id: '51-100', label: '51–100 permits', min: 51, max: 100 },
    { id: '100+', label: '100+ permits', min: 101, max: Number.POSITIVE_INFINITY },
];

interface IrelandSponsorshipStats {
    total: number;
    totalPermitsIssued: number;
    maxPermits: number;
    cityCounts: Array<{ city: string; count: number }>;
    yearCounts: Array<{ year: IrelandPermitYear; count: number }>;
    permitRangeCounts: Array<{ id: string; label: string; count: number }>;
    years: IrelandPermitYear[];
    /** True when permitRangeCounts / result volume use selected year(s). */
    volumeScopedToYears: boolean;
}

interface IrelandSponsorshipCache {
    all: IrelandEmployerRecord[];
    stats: IrelandSponsorshipStats;
}

export interface IrelandEmployerResult {
    employerName: string;
    city: string | null;
    permitsByYear: Record<IrelandPermitYear, number>;
    permitsJan: number;
    permitsFeb: number;
    permitsMar: number;
    permitsApr: number;
    permitsMay: number;
    permitsJun: number;
    permitsJul: number;
    totalPermits: number;
}

export interface IrelandSponsorshipQueryResult {
    companies: IrelandEmployerResult[];
    page: number;
    totalPages: number;
    totalCount: number;
    stats: IrelandSponsorshipStats;
}

let _irelandCache: IrelandSponsorshipCache | null = null;
let _irelandCacheBuildPromise: Promise<IrelandSponsorshipCache> | null = null;

export function invalidateIrelandSponsorshipCache(): void {
    _irelandCache = null;
    _irelandCacheBuildPromise = null;
}

function detectCityFromEmployerName(name: string): string | null {
    for (const city of IRELAND_CITIES) {
        const pattern = new RegExp(`\\b${city}\\b`, 'i');
        if (pattern.test(name)) return city;
    }
    return null;
}

function emptyPermitsByYear(): Record<IrelandPermitYear, number> {
    return {
        '2020': 0,
        '2021': 0,
        '2022': 0,
        '2023': 0,
        '2024': 0,
        '2025': 0,
        '2026': 0,
    };
}

function normalizePermitsByYear(raw: Record<string, number> | undefined): Record<IrelandPermitYear, number> {
    const out = emptyPermitsByYear();
    if (!raw) return out;
    for (const year of IRELAND_PERMIT_YEARS) {
        const value = raw[year];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            out[year] = value;
        }
    }
    return out;
}

export function normalizeIrelandCityFilter(raw: string | undefined): string[] | undefined {
    if (raw == null) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    const cities = trimmed
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

    const valid = new Set<string>(IRELAND_CITIES);
    const normalized = cities.filter((c) => valid.has(c));
    return normalized.length > 0 ? normalized : undefined;
}

export function normalizeIrelandYearFilter(raw: string | undefined): IrelandPermitYear[] | undefined {
    if (raw == null) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    const valid = new Set<string>(IRELAND_PERMIT_YEARS);
    const years = trimmed
        .split(',')
        .map((y) => y.trim())
        .filter((y) => valid.has(y)) as IrelandPermitYear[];
    return years.length > 0 ? years : undefined;
}

export function normalizeIrelandRangeFilter(raw: string | undefined): PermitRangeDef[] | undefined {
    if (raw == null) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    const byId = new Map(IRELAND_PERMIT_RANGES.map((r) => [r.id, r]));
    const ranges = trimmed
        .split(',')
        .map((id) => id.trim())
        .map((id) => byId.get(id))
        .filter((r): r is PermitRangeDef => Boolean(r));
    return ranges.length > 0 ? ranges : undefined;
}

export type IrelandVolumeEmployer = {
    permitsByYear: Record<IrelandPermitYear, number>;
    totalPermits: number;
};

export function matchesAnyPermitRange(permitCount: number, ranges: PermitRangeDef[]): boolean {
    return ranges.some((r) => permitCount >= r.min && permitCount <= r.max);
}

/**
 * Volume metric for range filters.
 * When years are selected: sum of permits in those years.
 * Otherwise: lifetime total (2020–2026).
 */
export function volumePermitCount(
    employer: IrelandVolumeEmployer,
    years: readonly IrelandPermitYear[] | null | undefined
): number {
    if (!years || years.length === 0) return employer.totalPermits;
    return years.reduce((sum, y) => sum + (employer.permitsByYear[y] ?? 0), 0);
}

type IrelandFilterContext = {
    query: string | null;
    citySet: Set<string> | null;
    yearList: IrelandPermitYear[] | null;
    rangeList: PermitRangeDef[] | null;
};

function matchesSearchAndCity(
    c: IrelandEmployerRecord,
    query: string | null,
    citySet: Set<string> | null
): boolean {
    if (query && !c._nameLower.includes(query)) return false;
    if (citySet && (!c._cityLower || !citySet.has(c._cityLower))) return false;
    return true;
}

/** Pure filter used by query + facets. Year and range lists are AND'd when both set. */
function employerMatchesIrelandFilters(
    c: IrelandEmployerRecord,
    ctx: IrelandFilterContext
): boolean {
    if (!matchesSearchAndCity(c, ctx.query, ctx.citySet)) return false;
    if (ctx.yearList && !ctx.yearList.some((y) => c.permitsByYear[y] > 0)) return false;
    if (ctx.rangeList && !matchesAnyPermitRange(volumePermitCount(c, ctx.yearList), ctx.rangeList)) {
        return false;
    }
    return true;
}

function buildFacetStats(
    all: IrelandEmployerRecord[],
    base: IrelandSponsorshipStats,
    ctx: IrelandFilterContext
): IrelandSponsorshipStats {
    const volumeYears = ctx.yearList;

    // Range facets: apply search/city/years, then bucket by volume metric.
    const forRanges = all.filter((c) => {
        if (!matchesSearchAndCity(c, ctx.query, ctx.citySet)) return false;
        if (volumeYears && !volumeYears.some((y) => c.permitsByYear[y] > 0)) return false;
        return true;
    });

    const permitRangeCounts = IRELAND_PERMIT_RANGES.map((range) => ({
        id: range.id,
        label: range.label,
        count: forRanges.reduce((sum, e) => {
            const volume = volumePermitCount(e, volumeYears);
            return sum + (volume >= range.min && volume <= range.max ? 1 : 0);
        }, 0),
    }));

    // Year facets: apply search/city/ranges (volume uses selected years when set).
    const forYears = all.filter((c) => {
        if (!matchesSearchAndCity(c, ctx.query, ctx.citySet)) return false;
        if (ctx.rangeList && !matchesAnyPermitRange(volumePermitCount(c, volumeYears), ctx.rangeList)) {
            return false;
        }
        return true;
    });

    const yearCounts = IRELAND_PERMIT_YEARS.map((year) => ({
        year,
        count: forYears.reduce((sum, e) => sum + (e.permitsByYear[year] > 0 ? 1 : 0), 0),
    }));

    return {
        ...base,
        yearCounts,
        permitRangeCounts,
        volumeScopedToYears: Boolean(volumeYears && volumeYears.length > 0),
    };
}

async function buildIrelandSponsorshipCache(): Promise<IrelandSponsorshipCache> {
    let jsonPath: string | null = null;
    for (const candidate of MERGED_JSON_CANDIDATES) {
        try {
            await fs.promises.access(candidate);
            jsonPath = candidate;
            break;
        } catch {
            /* try next */
        }
    }

    if (!jsonPath) {
        throw new Error('ireland-employment-permits-merged.json not found in data/');
    }

    console.log(`[ireland-sponsorship] Loading merged dataset from ${jsonPath}`);
    const text = await fs.promises.readFile(jsonPath, 'utf-8');
    const parsed = JSON.parse(text) as { employers?: MergedEmployerJson[] };

    const all: IrelandEmployerRecord[] = [];
    let totalPermitsIssued = 0;
    let maxPermits = 0;
    const cityCountMap = new Map<string, number>();

    for (const city of IRELAND_CITIES) {
        cityCountMap.set(city, 0);
    }

    for (const row of parsed.employers ?? []) {
        const employerName = (row.employerName ?? '').trim();
        if (!employerName || isIrelandSummaryEmployerName(employerName)) continue;

        const permitsByYear = normalizePermitsByYear(row.permitsByYear);
        const totalPermits =
            typeof row.totalPermits === 'number' && row.totalPermits > 0
                ? row.totalPermits
                : Object.values(permitsByYear).reduce((sum, n) => sum + n, 0);

        if (totalPermits <= 0) continue;

        totalPermitsIssued += totalPermits;
        maxPermits = Math.max(maxPermits, totalPermits);

        const city = detectCityFromEmployerName(employerName);
        if (city) {
            cityCountMap.set(city, (cityCountMap.get(city) ?? 0) + 1);
        }

        all.push({
            employerName,
            city,
            permitsByYear,
            permitsJan: row.permitsJan ?? 0,
            permitsFeb: row.permitsFeb ?? 0,
            permitsMar: row.permitsMar ?? 0,
            permitsApr: row.permitsApr ?? 0,
            permitsMay: row.permitsMay ?? 0,
            permitsJun: row.permitsJun ?? 0,
            permitsJul: row.permitsJul ?? 0,
            totalPermits,
            _nameLower: employerName.toLowerCase(),
            _cityLower: city?.toLowerCase() ?? null,
        });
    }

    all.sort((a, b) => b.totalPermits - a.totalPermits || a.employerName.localeCompare(b.employerName));

    const cityCounts = IRELAND_CITIES.map((city) => ({
        city,
        count: cityCountMap.get(city) ?? 0,
    })).filter((entry) => entry.count > 0);

    const yearCounts = IRELAND_PERMIT_YEARS.map((year) => ({
        year,
        count: all.reduce((sum, e) => sum + (e.permitsByYear[year] > 0 ? 1 : 0), 0),
    }));

    const permitRangeCounts = IRELAND_PERMIT_RANGES.map((range) => ({
        id: range.id,
        label: range.label,
        count: all.reduce(
            (sum, e) => sum + (e.totalPermits >= range.min && e.totalPermits <= range.max ? 1 : 0),
            0
        ),
    }));

    console.log(`[ireland-sponsorship] Cache built: ${all.length} employers, ${totalPermitsIssued} permits`);

    return {
        all,
        stats: {
            total: all.length,
            totalPermitsIssued,
            maxPermits,
            cityCounts,
            yearCounts,
            permitRangeCounts,
            years: [...IRELAND_PERMIT_YEARS],
            volumeScopedToYears: false,
        },
    };
}

async function getIrelandSponsorshipCache(): Promise<IrelandSponsorshipCache> {
    if (_irelandCache) return _irelandCache;

    if (!_irelandCacheBuildPromise) {
        _irelandCacheBuildPromise = buildIrelandSponsorshipCache()
            .then((cache) => {
                _irelandCache = cache;
                _irelandCacheBuildPromise = null;
                return cache;
            })
            .catch((err) => {
                _irelandCacheBuildPromise = null;
                throw err;
            });
    }

    return _irelandCacheBuildPromise;
}

export async function warmIrelandSponsorshipCache(force = false): Promise<{
    total: number;
    totalPermitsIssued: number;
    durationMs: number;
}> {
    if (force) invalidateIrelandSponsorshipCache();
    const started = Date.now();
    const cache = await getIrelandSponsorshipCache();
    return {
        total: cache.stats.total,
        totalPermitsIssued: cache.stats.totalPermitsIssued,
        durationMs: Date.now() - started,
    };
}

function toPublicEmployer({
    employerName,
    city,
    permitsByYear,
    permitsJan,
    permitsFeb,
    permitsMar,
    permitsApr,
    permitsMay,
    permitsJun,
    permitsJul,
    totalPermits,
}: IrelandEmployerRecord): IrelandEmployerResult {
    return {
        employerName,
        city,
        permitsByYear,
        permitsJan,
        permitsFeb,
        permitsMar,
        permitsApr,
        permitsMay,
        permitsJun,
        permitsJul,
        totalPermits,
    };
}

export async function listIrelandSponsorshipRegister(): Promise<
    Array<{ employerName: string; city: string | null; totalPermits: number }>
> {
    const cache = await getIrelandSponsorshipCache();
    return cache.all.map(({ employerName, city, totalPermits }) => ({
        employerName,
        city,
        totalPermits,
    }));
}

export async function queryIrelandSponsorshipData(
    page: number,
    q: string | undefined,
    cities: string[] | undefined,
    years?: IrelandPermitYear[],
    ranges?: PermitRangeDef[]
): Promise<IrelandSponsorshipQueryResult> {
    const cache = await getIrelandSponsorshipCache();

    const ctx: IrelandFilterContext = {
        query: q?.trim().toLowerCase() || null,
        citySet: cities ? new Set(cities.map((c) => c.toLowerCase())) : null,
        yearList: years && years.length > 0 ? years : null,
        rangeList: ranges && ranges.length > 0 ? ranges : null,
    };

    const source = cache.all.filter((c) => employerMatchesIrelandFilters(c, ctx));
    const stats = buildFacetStats(cache.all, cache.stats, ctx);

    const totalCount = source.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / SPONSORSHIP_PAGE_SIZE));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const offset = (safePage - 1) * SPONSORSHIP_PAGE_SIZE;

    return {
        companies: source.slice(offset, offset + SPONSORSHIP_PAGE_SIZE).map(toPublicEmployer),
        page: safePage,
        totalPages,
        totalCount,
        stats,
    };
}
