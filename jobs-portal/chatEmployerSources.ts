import { createHash } from 'node:crypto';
import { PART_TIME_UK_CITIES } from './partTimeCities';
import { canonicalJobUrl } from './chatWebUrls';
import type { JobsPortalJob, PublicJobsPortalCompany } from './types';
import { createChatExecution } from './chatExecution';

export interface EmployerBoard {
    provider: 'greenhouse' | 'lever' | 'ashby';
    token: string;
    region?: 'eu' | 'global';
    /** An employer identity already established by the caller, never a guessed board slug. */
    name?: string;
    website?: string;
    company?: PublicJobsPortalCompany;
}

export interface EmployerSourceDependencies {
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    timeoutMs?: number;
}

export interface EmployerBoardResult {
    jobs: JobsPortalJob[];
    examined: number;
    excluded: number;
    retrievedAt: string;
    cacheHit: false;
    limitReached: boolean;
}

export class EmployerSourceError extends Error {
    constructor(
        readonly code:
            'INVALID_BOARD' | 'UNAVAILABLE' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'TOO_LARGE' | 'EMPLOYER_UNIDENTIFIED',
    ) {
        super('This employer’s live vacancies could not be checked.');
        this.name = 'EmployerSourceError';
    }
}

const TOKEN = /^[a-zA-Z0-9_-]{1,150}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 200;

/** Accept only an actual supported ATS URL; never invent a board from an employer name. */
export function parseEmployerBoardUrl(value: string): EmployerBoard | null {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    let provider: EmployerBoard['provider'];
    let token: string | null | undefined;
    let region: EmployerBoard['region'] = 'global';
    if (
        [
            'boards.greenhouse.io',
            'boards.eu.greenhouse.io',
            'job-boards.greenhouse.io',
            'job-boards.eu.greenhouse.io',
        ].includes(host)
    ) {
        provider = 'greenhouse';
        region = host.includes('.eu.') ? 'eu' : 'global';
        token = parts[0] === 'embed' ? url.searchParams.get('for') : parts[0];
    } else if (
        ['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io'].includes(host) &&
        parts[0] === 'v1' &&
        parts[1] === 'boards'
    ) {
        provider = 'greenhouse';
        token = parts[2];
        region = host.includes('.eu.') ? 'eu' : 'global';
    } else if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(host)) {
        provider = 'lever';
        token = parts[0];
        region = host.includes('.eu.') ? 'eu' : 'global';
    } else if (['api.lever.co', 'api.eu.lever.co'].includes(host) && parts[0] === 'v0' && parts[1] === 'postings') {
        provider = 'lever';
        token = parts[2];
        region = host.includes('.eu.') ? 'eu' : 'global';
    } else if (host === 'jobs.ashbyhq.com') {
        provider = 'ashby';
        token = parts[0];
    } else if (host === 'api.ashbyhq.com' && parts[0] === 'posting-api' && parts[1] === 'job-board') {
        provider = 'ashby';
        token = parts[2];
    } else return null;
    return token && TOKEN.test(token) ? { provider, token, region } : null;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, maximum = 500_000): string {
    return typeof value === 'string' && value.length <= maximum ? value.trim() : '';
}
function nested(value: unknown, ...keys: string[]): unknown {
    let current = value;
    for (const key of keys) {
        if (!record(current)) return undefined;
        current = current[key];
    }
    return current;
}
function decodeEntities(value: string): string {
    return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[a-f0-9]{1,6});/gi, (entity) => {
        const named: Record<string, string> = {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&apos;': "'",
            '&nbsp;': ' ',
        };
        if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
        const code = entity.toLowerCase().startsWith('&#x')
            ? Number.parseInt(entity.slice(3, -1), 16)
            : Number.parseInt(entity.slice(2, -1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    });
}
/** Greenhouse can HTML-encode an entire HTML document. Decode before stripping, then strip decoded tags again. */
function plain(value: unknown): string {
    return decodeEntities(decodeEntities(text(value)))
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<\s*br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim();
}

const OTHER_COUNTRY =
    /\b(?:united states|united states of america|usa|u\.s\.?a?\.?|canada|ontario|quebec|british columbia|australia|new zealand|massachusetts|connecticut|pennsylvania|new york|new jersey|california|texas|germany|france|spain|italy|netherlands|sweden|norway|denmark|finland|poland|portugal|belgium|switzerland|austria|czechia|romania|hungary|greece|india|singapore|china|japan|hong kong|philippines|pakistan|bangladesh|brazil|mexico|argentina|south africa|nigeria|egypt|israel|united arab emirates|dubai|saudi arabia)\b/i;
const AMBIGUOUS_CITIES = new Set([
    'Perth',
    'York',
    'Newport',
    'Bangor',
    'Cambridge',
    'Oxford',
    'Bath',
    'Durham',
    'Lincoln',
    'Lancaster',
    'Chester',
    'Preston',
    'Peterborough',
    'Portsmouth',
    'Plymouth',
    'Southampton',
    'Stirling',
    'Aberdeen',
    'Wells',
    'Winchester',
    'Worcester',
    'Salisbury',
    'Gloucester',
    'Ripon',
]);
const UK_CITIES = PART_TIME_UK_CITIES.filter((city) => !AMBIGUOUS_CITIES.has(city));
function countryMatches(location: string, target: 'uk' | 'ireland', structured: unknown): boolean {
    const code = typeof structured === 'string' ? structured.trim().toLowerCase() : '';
    const structuredCountry = ['gb', 'gbr', 'uk', 'united kingdom', 'great britain'].includes(code)
        ? 'uk'
        : ['ie', 'irl', 'ireland', 'republic of ireland'].includes(code)
          ? 'ireland'
          : code
            ? 'other'
            : undefined;
    if (structuredCountry && structuredCountry !== target) return false;
    if (OTHER_COUNTRY.test(location) || /(?:^|[,;|])\s*(?!uk\b|gb\b|ie\b)[a-z]{2}\s*(?:$|[,;|])/i.test(location))
        return false;
    const uk = /\b(?:united kingdom|great britain|england|scotland|wales|northern ireland|uk|gb)\b/i.test(location);
    const ireland = /\b(?:republic of ireland|ireland)\b/i.test(location.replace(/\bnorthern ireland\b/gi, ''));
    if (uk && ireland) return false;
    if ((target === 'uk' && ireland) || (target === 'ireland' && uk)) return false;
    if (structuredCountry === target || (target === 'uk' ? uk : ireland)) return true;
    return target === 'uk'
        ? UK_CITIES.some((city) =>
              new RegExp(`(?:^|[\\s,;|(/])${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s,;|)/])`, 'i').test(
                  location,
              ),
          )
        : /\b(?:dublin|cork|galway|limerick|waterford|kilkenny|drogheda|athlone|sligo)\b/i.test(location);
}

function date(value: unknown): string | undefined {
    const number =
        typeof value === 'number' && Number.isFinite(value)
            ? value < 100_000_000_000
                ? value * 1000
                : value
            : undefined;
    if (
        number === undefined &&
        (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value))
    )
        return undefined;
    if (typeof value === 'string') {
        const [year, month, day] = value.slice(0, 10).split('-').map(Number);
        if (!year || !month || !day || month > 12 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
            return undefined;
    }
    const timestamp =
        number ??
        Date.parse(
            /(?:Z|[+-]\d{2}:?\d{2})$/.test(value as string)
                ? (value as string)
                : `${value}${String(value).includes('T') ? 'Z' : 'T00:00:00Z'}`,
        );
    return Number.isFinite(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime())
        ? new Date(timestamp).toISOString()
        : undefined;
}
function employment(value: unknown): string | undefined {
    const key = text(value, 80)
        .toLowerCase()
        .replace(/[\s_-]/g, '');
    return (
        {
            fulltime: 'Full-time',
            parttime: 'Part-time',
            contract: 'Contract',
            contractor: 'Contract',
            internship: 'Internship',
            intern: 'Internship',
            placement: 'Placement scheme',
            placementscheme: 'Placement scheme',
        } as Record<string, string>
    )[key];
}
function level(title: string): string | undefined {
    if (/\bsenior\b/i.test(title)) return 'Senior';
    if (/\bjunior\b/i.test(title)) return 'Junior';
    if (/\bgraduate\b|\bentry[- ]level\b/i.test(title)) return 'Entry Level';
    return undefined;
}
function metadata(row: Record<string, unknown>, matcher: RegExp): unknown {
    return Array.isArray(row.metadata)
        ? row.metadata.filter(record).find((item) => matcher.test(text(item.name, 100)))?.value
        : undefined;
}
function salary(row: Record<string, unknown>, provider: EmployerBoard['provider']): string | undefined {
    if (provider === 'lever' && record(row.salaryRange)) {
        const range = row.salaryRange;
        const currency = text(range.currency, 10).toUpperCase();
        const interval = text(range.interval, 30).toLowerCase();
        const symbol = ({ GBP: '£', EUR: '€', USD: '$' } as Record<string, string>)[currency];
        const period = (
            {
                year: 'per year',
                yearly: 'per year',
                annum: 'per year',
                hour: 'per hour',
                hourly: 'per hour',
                month: 'per month',
                monthly: 'per month',
            } as Record<string, string>
        )[interval];
        const minimum =
            typeof range.min === 'number' && Number.isFinite(range.min) && range.min > 0 ? range.min : undefined;
        const maximum =
            typeof range.max === 'number' && Number.isFinite(range.max) && range.max > 0 ? range.max : undefined;
        if (
            symbol &&
            (minimum !== undefined || maximum !== undefined) &&
            !(minimum !== undefined && maximum !== undefined && minimum > maximum)
        ) {
            const amount =
                minimum !== undefined && maximum !== undefined
                    ? `${symbol}${minimum.toLocaleString('en-GB')} - ${maximum.toLocaleString('en-GB')}`
                    : minimum !== undefined
                      ? `from ${symbol}${minimum.toLocaleString('en-GB')}`
                      : `up to ${symbol}${maximum!.toLocaleString('en-GB')}`;
            return `${amount}${period ? ` ${period}` : ''}`;
        }
    }
    const value =
        provider === 'greenhouse'
            ? metadata(row, /^salary|^compensation/i)
            : provider === 'ashby'
              ? (row.compensationTierSummary ??
                nested(row, 'compensation', 'compensationTierSummary') ??
                nested(row, 'compensation', 'scrapeableCompensationSalarySummary'))
              : row.salaryDescription;
    return plain(value).slice(0, 1000) || undefined;
}

function project(
    row: unknown,
    board: EmployerBoard,
    employer: string,
    country: 'uk' | 'ireland',
    now: number,
    retrievedAt: string,
): JobsPortalJob | null {
    if (!record(row) || row.isListed === false || row.isArchived === true || row.status === 'CLOSED') return null;
    const isLever = board.provider === 'lever';
    const title = plain(isLever ? row.text : row.title).slice(0, 300);
    const location = plain(
        board.provider === 'greenhouse'
            ? nested(row, 'location', 'name')
            : isLever
              ? nested(row, 'categories', 'location')
              : typeof row.location === 'string'
                ? row.location
                : nested(row, 'location', 'name'),
    );
    const rawDescription =
        board.provider === 'greenhouse'
            ? row.content
            : board.provider === 'ashby'
              ? (row.descriptionHtml ?? row.descriptionPlain)
              : [
                    row.descriptionPlain || row.description,
                    ...(Array.isArray(row.lists)
                        ? row.lists.filter(record).map((list) => `${text(list.text, 100)}\n${text(list.content)}`)
                        : []),
                    row.additionalPlain || row.additional,
                ]
                    .filter(Boolean)
                    .join('\n\n');
    const description = plain(rawDescription);
    const url = canonicalJobUrl(
        board.provider === 'greenhouse'
            ? row.absolute_url
            : isLever
              ? row.hostedUrl || row.applyUrl
              : row.jobUrl || row.applyUrl,
    );
    const structuredCountry =
        nested(row, 'address', 'postalAddress', 'addressCountry') ?? nested(row, 'location', 'country') ?? row.country;
    const published = board.provider === 'greenhouse' ? undefined : isLever ? row.createdAt : row.publishedAt;
    const postedAt = date(published);
    const rawExpiry = row.validThrough ?? row.expiresAt ?? row.expirationDate;
    const expiresAt = date(rawExpiry);
    if (
        !title ||
        !location ||
        description.length < 50 ||
        !url ||
        !countryMatches(location, country, structuredCountry) ||
        (published !== undefined && published !== null && published !== '' && !postedAt) ||
        (postedAt && Date.parse(postedAt) > now) ||
        (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '' && !expiresAt) ||
        (expiresAt && Date.parse(expiresAt) <= now)
    )
        return null;
    const arrangement = text(
        isLever ? row.workplaceType : (row.workplaceType ?? metadata(row, /workplace|working arrangement/i)),
        30,
    );
    const jobType = employment(
        isLever
            ? nested(row, 'categories', 'commitment')
            : (row.employmentType ?? metadata(row, /employment|job.*type/i)),
    );
    const department = plain(
        board.provider === 'greenhouse'
            ? nested(Array.isArray(row.departments) ? row.departments[0] : undefined, 'name')
            : isLever
              ? (nested(row, 'categories', 'department') ?? nested(row, 'categories', 'team'))
              : row.department,
    );
    const company = board.company || {
        id: 0,
        trading_name: employer,
        companies_house_name: null,
        url: canonicalJobUrl(board.website),
        url_linkedin: null,
        url_favicon: null,
        description: '',
        estimated_num_employees_label: null,
        licensed_sponsor: false,
        ireland_permit_employer: false,
        cos_used_count_2025: null,
        open_to_sponsorship: null,
        show_recently_added_badge: false,
        added_to_register: null,
    };
    return {
        id: `web:${createHash('sha256').update(url).digest('hex')}`,
        title,
        url,
        description,
        location: `${location}${/^(remote|hybrid|on[- ]?site)$/i.test(arrangement) ? ` | ${arrangement}` : ''}`,
        department,
        ...(jobType ? { jobType } : {}),
        ...(level(title) ? { level: level(title) } : {}),
        ...(salary(row, board.provider) ? { salary: salary(row, board.provider) } : {}),
        // An unknown publication date stays unknown; a live check must not manufacture recency.
        created_at: postedAt || '',
        company_id: company.id,
        company,
        listingSource: {
            kind: 'web',
            provider: 'employer-sites',
            publisher: board.provider === 'greenhouse' ? 'Greenhouse' : board.provider === 'lever' ? 'Lever' : 'Ashby',
            retrievedAt,
            ...(postedAt ? { postedAt } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            availability: 'source-listed',
            employerLicence: board.company?.licensed_sponsor ? 'catalogue-match' : 'unknown',
        },
    };
}

async function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new EmployerSourceError('TIMEOUT');
    let onAbort: () => void = () => undefined;
    const timeout = new Promise<never>((_, reject) => {
        onAbort = () => reject(new EmployerSourceError('TIMEOUT'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

async function body(response: Response, signal: AbortSignal): Promise<string> {
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        throw new EmployerSourceError('TOO_LARGE');
    }
    if (!response.body) throw new EmployerSourceError('INVALID_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const chunk = await beforeDeadline(reader.read(), signal);
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > MAX_BYTES) {
                void reader.cancel().catch(() => undefined);
                throw new EmployerSourceError('TOO_LARGE');
            }
            chunks.push(chunk.value);
        }
        return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
}

function employerFromHtml(html: string): string | undefined {
    const names = new Set<string>();
    function visit(value: unknown, depth = 0): void {
        if (depth > 5) return;
        if (Array.isArray(value)) {
            value.slice(0, 50).forEach((item) => visit(item, depth + 1));
            return;
        }
        if (!record(value)) return;
        if (
            value['@type'] === 'JobPosting' ||
            (Array.isArray(value['@type']) && value['@type'].includes('JobPosting'))
        ) {
            const name = plain(nested(value, 'hiringOrganization', 'name'));
            if (name && name.length <= 200) names.add(name);
        }
        if (value['@graph']) visit(value['@graph'], depth + 1);
    }
    const scripts = html.matchAll(
        /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
    );
    let count = 0;
    for (const script of scripts) {
        if (++count > 20) break;
        if (script[1]!.length > 64 * 1024) continue;
        try {
            visit(JSON.parse(script[1]!));
        } catch {
            /* Untrusted malformed structured data cannot establish identity. */
        }
    }
    return names.size === 1 ? [...names][0] : undefined;
}

/** Reads public published listings only. This module never imports a database client or writes a cache. */
export async function fetchEmployerBoardJobs(
    board: EmployerBoard,
    country: 'uk' | 'ireland',
    deps: EmployerSourceDependencies = {},
): Promise<EmployerBoardResult> {
    if (
        !board ||
        !['greenhouse', 'lever', 'ashby'].includes(board.provider) ||
        !TOKEN.test(board.token) ||
        (board.region !== undefined && !['eu', 'global'].includes(board.region)) ||
        !['uk', 'ireland'].includes(country)
    )
        throw new EmployerSourceError('INVALID_BOARD');
    const now = (deps.now || Date.now)();
    const retrievedAt = new Date(now).toISOString();
    const timeout = Number.isFinite(deps.timeoutMs) ? Math.max(1, Math.min(8000, deps.timeoutMs!)) : 8000;
    const execution = createChatExecution({ signal: deps.signal, timeoutMs: timeout });
    const signal = execution.signal;
    const fetcher = deps.fetch || globalThis.fetch;
    const ghHost = board.region === 'eu' ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io';
    const api =
        board.provider === 'greenhouse'
            ? `https://${ghHost}/v1/boards/${board.token}/jobs?content=true`
            : board.provider === 'lever'
              ? `https://${board.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${board.token}?mode=json`
              : `https://api.ashbyhq.com/posting-api/job-board/${board.token}?includeCompensation=true`;
    const get = async (url: string): Promise<string> => {
        if (signal.aborted) throw new EmployerSourceError('TIMEOUT');
        const response = await beforeDeadline(
            fetcher(url, {
                method: 'GET',
                redirect: 'error',
                signal,
                headers: {
                    Accept: 'application/json,text/html;q=0.5',
                    'User-Agent': 'CAFY/1.0 (public employer job search)',
                },
            }),
            signal,
        );
        if (!response.ok || response.redirected) throw new EmployerSourceError('UNAVAILABLE');
        return body(response, signal);
    };
    try {
        let payload: unknown;
        try {
            payload = JSON.parse(await get(api));
        } catch (error) {
            if (error instanceof EmployerSourceError) throw error;
            if (signal.aborted) throw new EmployerSourceError('TIMEOUT');
            throw new EmployerSourceError('INVALID_RESPONSE');
        }
        const rawRows = board.provider === 'lever' ? payload : nested(payload, 'jobs');
        if (!Array.isArray(rawRows)) throw new EmployerSourceError('INVALID_RESPONSE');
        let name = plain(board.company?.trading_name || board.name);
        if (!name)
            name = plain(
                nested(payload, 'organizationName') ??
                    nested(payload, 'companyName') ??
                    nested(payload, 'organization', 'name'),
            );
        if (!name && board.provider === 'greenhouse') {
            const info: unknown = JSON.parse(await get(`https://${ghHost}/v1/boards/${board.token}`));
            name = plain(nested(info, 'name'));
        }
        if (!name && board.provider !== 'greenhouse') {
            const site =
                board.provider === 'ashby'
                    ? 'jobs.ashbyhq.com'
                    : board.region === 'eu'
                      ? 'jobs.eu.lever.co'
                      : 'jobs.lever.co';
            name = employerFromHtml(await get(`https://${site}/${board.token}`)) || '';
        }
        if (!name || name.length > 200 || /^(?:unknown|company|employer|lever|greenhouse|ashby)$/i.test(name))
            throw new EmployerSourceError('EMPLOYER_UNIDENTIFIED');
        const rows = rawRows.slice(0, MAX_RECORDS);
        const jobs = rows
            .map((row) => project(row, board, name, country, now, retrievedAt))
            .filter((job): job is JobsPortalJob => Boolean(job));
        const seen = new Set<string>();
        const unique = jobs.filter((job) => {
            if (seen.has(job.id)) return false;
            seen.add(job.id);
            return true;
        });
        return {
            jobs: unique,
            examined: rows.length,
            excluded: rows.length - unique.length,
            retrievedAt,
            cacheHit: false,
            limitReached: rawRows.length > MAX_RECORDS,
        };
    } catch (error) {
        if (error instanceof EmployerSourceError) throw error;
        throw new EmployerSourceError(signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
    } finally {
        execution.cleanup();
    }
}
