import { createHash } from 'node:crypto';
import type { ChatSearch } from './chatIntent';
import type { JobsPortalJob } from './types';
import { canonicalJobUrl } from './chatWebUrls';
import { PART_TIME_UK_CITIES } from './partTimeCities';
import { createChatExecution } from './chatExecution';

const ORIGIN = 'https://www.jobs.service.gov.uk';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_JOBS = 10;
const JOB_PATH = /^\/jobs\/([a-f0-9]{24})$/;

export interface GovernmentSourceDependencies {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Trusted server-only exact paths for an encrypted continuation; not an HTTP input. */
    jobPaths?: string[];
    /** Keep the original Work Hub identity even when the public apply URL is traced. */
    onJob?: (job: JobsPortalJob, sourceUrl: string) => void;
}
export interface GovernmentSourceResult {
    jobs: JobsPortalJob[];
    examined: number;
    excluded: number;
    retrievedAt: string;
    cacheHit: false;
    boardsChecked: number;
    boardsFailed: number;
    boardsAvailable: number;
    limitReached: boolean;
}
export class GovernmentSourceError extends Error {
    constructor() {
        super('The official government job source is unavailable.');
        this.name = 'GovernmentSourceError';
    }
}

function decode(value: string): string {
    return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|pound|#\d{1,7}|#x[a-f0-9]{1,6});/gi, (entity) => {
        const known: Record<string, string> = {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&apos;': "'",
            '&nbsp;': ' ',
            '&pound;': '£',
        };
        if (known[entity.toLowerCase()]) return known[entity.toLowerCase()]!;
        const number = entity.toLowerCase().startsWith('&#x')
            ? Number.parseInt(entity.slice(3, -1), 16)
            : Number.parseInt(entity.slice(2, -1), 10);
        return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
            ? String.fromCodePoint(number)
            : ' ';
    });
}
function plain(value: string): string {
    return decode(decode(value))
        .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ')
        .replace(/<\s*br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .trim();
}
function field(html: string, name: string): string {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return plain(
        new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*data-testid=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'i').exec(
            html,
        )?.[2] || '',
    );
}
function descriptionHtml(html: string): string {
    const opening = /<div\b[^>]*class=["'][^"']*\brawHtmlContainer\b[^"']*["'][^>]*>/i.exec(html);
    if (!opening) return '';
    const start = opening.index + opening[0].length;
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = start;
    let depth = 1;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
        depth += /^<\//.test(tag[0]) ? -1 : 1;
        if (!depth) return html.slice(start, tag.index);
    }
    return '';
}
function sourceDate(value: string, closing: boolean): string | undefined {
    if (!value) return undefined;
    const match = /^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/i.exec(value);
    if (!match) return undefined;
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        match[2]!.toLowerCase(),
    );
    const day = Number(match[1]);
    const year = Number(match[3]);
    if (month < 0 || day < 1 || day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate()) return undefined;
    const utcHour = closing ? 23 : 0;
    const timestamp = Date.UTC(year, month, day, utcHour, closing ? 59 : 0, closing ? 59 : 0, closing ? 999 : 0);
    const localHour = Number(
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(
            new Date(timestamp),
        ),
    );
    // The advert supplies a UK calendar date. Do not keep a summer closing date
    // open an extra hour by treating its local midnight as UTC midnight.
    return new Date(timestamp - ((localHour - utcHour + 24) % 24) * 60 * 60 * 1000).toISOString();
}
function ukLocation(location: string): boolean {
    if (
        /\b(?:united states|usa|canada|ontario|quebec|british columbia|massachusetts|connecticut|pennsylvania|new york|new jersey|california|texas|australia|new zealand|germany|france|spain|italy|netherlands|sweden|norway|denmark|finland|poland|portugal|belgium|switzerland|austria|czechia|romania|hungary|greece|india|singapore|china|japan|hong kong|philippines|pakistan|bangladesh|brazil|mexico|argentina|south africa|nigeria|egypt|israel|dubai|saudi arabia|united arab emirates|republic of ireland)\b/i.test(
            location,
        ) ||
        /(?:^|[,;|])\s*(?!uk\b|gb\b)[a-z]{2}\s*(?:$|[,;|])/i.test(location)
    )
        return false;
    if (/\b(?:ireland|dublin|cork|galway)\b/i.test(location.replace(/\bnorthern ireland\b/gi, ''))) return false;
    if (/\b(?:united kingdom|great britain|england|scotland|wales|northern ireland|uk|gb)\b/i.test(location))
        return true;
    if (
        /\b(?:GIR\s*0AA|(?:[A-PR-UWYZ][0-9][0-9A-HJKPSTUW]?|[A-PR-UWYZ][A-HK-Y][0-9][0-9ABEHMNPRVWXY]?)\s*[0-9][ABD-HJLNP-UW-Z]{2})\b/i.test(
            location,
        )
    )
        return true;
    return PART_TIME_UK_CITIES.some((city) =>
        new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(location),
    );
}
function civilServiceUrl(value: string): string | undefined {
    const safe = canonicalJobUrl(decode(value));
    if (!safe) return undefined;
    const url = new URL(safe);
    return ['www.civilservicejobs.service.gov.uk', 'civilservicejobs.service.gov.uk'].includes(url.hostname) &&
        url.pathname === '/csr/jobs.cgi' &&
        /^\d{4,14}$/.test(url.searchParams.get('jcode') || '')
        ? safe
        : undefined;
}

/** Public rendered fields only; an unknown employer identity is never filled from a guessed department URL. */
function projectWorkHub(html: string, url: string, retrievedAt: string, now: number): JobsPortalJob | null {
    const title = field(html, 'pageHeading');
    const name = field(html, 'companyName');
    const location = field(html, 'location');
    const description = plain(descriptionHtml(html));
    const postedRaw = field(html, 'postingDate');
    const closingRaw = field(html, 'closingDate');
    const postedAt = sourceDate(postedRaw, false);
    const expiresAt = sourceDate(closingRaw, true);
    if (
        !title ||
        title.length > 300 ||
        !name ||
        name.length > 200 ||
        !location ||
        !ukLocation(location) ||
        description.length < 50 ||
        description.length > 500_000 ||
        /\b(?:this job (?:has |is )?(?:closed|expired)|no longer accepting applications|this vacancy (?:is |has )?(?:closed|expired))\b/i.test(
            plain(html).slice(0, 20000),
        ) ||
        (postedRaw && !postedAt) ||
        (postedAt && Date.parse(postedAt) > now) ||
        (closingRaw && !expiresAt) ||
        (expiresAt && Date.parse(expiresAt) <= now)
    )
        return null;
    const hours = field(html, 'jobPattern');
    const type = field(html, 'jobType');
    const work = field(html, 'remoteWorking');
    const jobType = /^part[- ]time$/i.test(hours)
        ? 'Part-time'
        : /^full[- ]time$/i.test(hours)
          ? 'Full-time'
          : /^contract$/i.test(type)
            ? 'Contract'
            : undefined;
    const level = /\bsenior\b/i.test(title)
        ? 'Senior'
        : /\bjunior\b/i.test(title)
          ? 'Junior'
          : /\bgraduate\b|\bentry[- ]level\b/i.test(title)
            ? 'Entry Level'
            : undefined;
    const city = PART_TIME_UK_CITIES.find((value) =>
        new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(location),
    );
    return {
        id: `web:${createHash('sha256').update(url).digest('hex')}`,
        title,
        url,
        location: `${location}${/^(?:remote|hybrid|on[- ]site)\b/i.test(work) ? ` | ${/^(remote|hybrid|on[- ]site)/i.exec(work)![0]}` : ''}`,
        ...(city ? { city } : {}),
        description,
        ...(field(html, 'salary') ? { salary: field(html, 'salary') } : {}),
        ...(jobType ? { jobType } : {}),
        ...(level ? { level } : {}),
        created_at: postedAt || '',
        company_id: 0,
        company: {
            id: 0,
            trading_name: name,
            companies_house_name: null,
            url: null,
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
        },
        listingSource: {
            kind: 'web',
            provider: 'employer-sites',
            publisher: 'GOV.UK Work Hub',
            retrievedAt,
            ...(postedAt ? { postedAt } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            availability: 'source-listed',
            employerLicence: 'unknown',
        },
    };
}

/** Independent official-source GETs, never Google-grounding links or private accounts. */
export async function searchChatGovernmentJobs(
    search: ChatSearch,
    country: 'uk' | 'ireland',
    deps: GovernmentSourceDependencies = {},
): Promise<GovernmentSourceResult> {
    const now = (deps.now || Date.now)();
    const result: GovernmentSourceResult = {
        jobs: [],
        examined: 0,
        excluded: 0,
        retrievedAt: new Date(now).toISOString(),
        cacheHit: false,
        boardsChecked: 0,
        boardsFailed: 0,
        boardsAvailable: country === 'uk' ? 1 : 0,
        limitReached: false,
    };
    if (country !== 'uk' || search.unsupported.length) return result;
    if (deps.jobPaths !== undefined && (
        !Array.isArray(deps.jobPaths) || deps.jobPaths.length > MAX_JOBS ||
        deps.jobPaths.some((path) => typeof path !== 'string' || !JOB_PATH.test(path)) ||
        new Set(deps.jobPaths).size !== deps.jobPaths.length
    )) throw new GovernmentSourceError();
    const requestedTimeout = deps.timeoutMs ?? 20_000;
    const budget = createChatExecution({
        signal: deps.signal,
        timeoutMs: Number.isFinite(requestedTimeout) ? Math.max(0, Math.min(20_000, requestedTimeout)) : 20_000,
    });
    const fetcher = deps.fetch || globalThis.fetch;
    const get = async (url: string): Promise<string> =>
        budget.run(async () => {
            const parsed = new URL(url);
            const workHub =
                parsed.origin === ORIGIN &&
                /^\/jobs\/(?:search|[a-f0-9]{24}(?:\/before-you-apply)?)$/.test(parsed.pathname);
            const apl =
                parsed.origin === 'https://www.aplitrak.com' &&
                parsed.pathname === '/' &&
                /^[a-zA-Z0-9_+\/=.-]{1,1000}$/.test(parsed.searchParams.get('adid') || '');
            if ((!workHub && !apl) || parsed.username || parsed.password) throw new GovernmentSourceError();
            const response = await fetcher(url, {
                method: 'GET',
                redirect: 'manual',
                signal: budget.signal,
                headers: { Accept: 'text/html', 'User-Agent': 'CAFY/1.0 (public job search)' },
            });
            if (budget.signal.aborted) {
                void response.body?.cancel().catch(() => undefined);
                throw new GovernmentSourceError();
            }
            if (apl && response.status >= 300 && response.status < 400) {
                const target = civilServiceUrl(response.headers.get('location') || '');
                void response.body?.cancel().catch(() => undefined);
                if (target) return `<a href="${target}">Civil Service Jobs</a>`;
            }
            if (
                !response.ok ||
                response.redirected ||
                Number(response.headers.get('content-length')) > MAX_BYTES ||
                !response.body
            ) {
                void response.body?.cancel().catch(() => undefined);
                throw new GovernmentSourceError();
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let length = 0;
            const cancel = () => {
                void reader.cancel().catch(() => undefined);
            };
            budget.signal.addEventListener('abort', cancel, { once: true });
            try {
                while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    length += next.value.byteLength;
                    if (length > MAX_BYTES) {
                        cancel();
                        throw new GovernmentSourceError();
                    }
                    chunks.push(next.value);
                }
            } finally {
                budget.signal.removeEventListener('abort', cancel);
                reader.releaseLock();
            }
            if (budget.signal.aborted) throw new GovernmentSourceError();
            return Buffer.concat(chunks).toString('utf8');
        });
    try {
        const query = new URL('/jobs/search', ORIGIN);
        query.searchParams.set('keywords', [search.role, search.employer].filter(Boolean).join(' '));
        if (search.where) query.searchParams.set('location', search.where);
        if (search.employerScope === 'civil-service') query.searchParams.set('includeAllKeywords', 'civil service');
        const arrangements =
            search.workingArrangement === 'any'
                ? ['REMOTE', 'ONSITE', 'HYBRID', 'FIELD_BASED']
                : [search.workingArrangement === 'on-site' ? 'ONSITE' : search.workingArrangement.toUpperCase()];
        arrangements.forEach((value) => query.searchParams.append('jobBase', value));
        if (search.kind === 'part-time') query.searchParams.set('jobPattern', 'PART_TIME');
        let paths: string[];
        if (deps.jobPaths !== undefined) {
            paths = deps.jobPaths;
            result.boardsChecked = paths.length ? 1 : 0;
        } else {
            const html = await get(query.href);
            result.boardsChecked = 1;
            if (!html.includes('data-testid="keywords-input"') || !html.includes('/jobs/search'))
                throw new GovernmentSourceError();
            paths = [
                ...new Set([...html.matchAll(/href=["'](\/jobs\/[a-f0-9]{24})["']/gi)].map((match) => match[1]!)),
            ];
            result.limitReached = paths.length > MAX_JOBS || /pageNumber=(?:[2-9]|\d{2,})/.test(html);
        }
        const selected = paths.slice(0, MAX_JOBS);
        let next = 0;
        let failed = 0;
        const observations = new Array<JobsPortalJob | null>(selected.length).fill(null);
        await Promise.all(
            Array.from({ length: Math.min(3, selected.length) }, async () => {
                while (next < selected.length) {
                    const index = next++;
                    const path = selected[index]!;
                    result.examined++;
                    try {
                        const detail = await get(`${ORIGIN}${path}`);
                        if (
                            !detail.includes('data-testid="pageHeading"') ||
                            !detail.includes('data-testid="companyName"')
                        )
                            throw new GovernmentSourceError();
                        const job = projectWorkHub(detail, `${ORIGIN}${path}`, result.retrievedAt, now);
                        if (!job) {
                            result.excluded++;
                            continue;
                        }
                        if (search.employerScope === 'civil-service') {
                            try {
                                const beforeApply = await get(`${ORIGIN}${path}/before-you-apply`);
                                const links = [
                                    ...beforeApply.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
                                ];
                                const actual = links.find((match) =>
                                    /continue to the employer/i.test(plain(match[2]!)),
                                )?.[1];
                                let identity = actual ? civilServiceUrl(decode(actual)) : undefined;
                                if (!identity && actual) {
                                    const candidate = canonicalJobUrl(decode(actual));
                                    if (candidate && new URL(candidate).hostname === 'www.aplitrak.com') {
                                        const traced = await get(candidate);
                                        identity = [
                                            ...traced.matchAll(
                                                /https:\/\/(?:www\.)?civilservicejobs\.service\.gov\.uk\/[^\s"'<>]+/gi,
                                            ),
                                        ]
                                            .map((match) => civilServiceUrl(match[0]))
                                            .find(Boolean);
                                    }
                                }
                                if (identity) {
                                    job.url = identity;
                                    job.id = `web:${createHash('sha256').update(identity).digest('hex')}`;
                                }
                            } catch {
                                result.limitReached = true;
                            }
                        }
                        observations[index] = job;
                        deps.onJob?.(job, `${ORIGIN}${path}`);
                    } catch {
                        result.excluded++;
                        failed++;
                        result.limitReached = true;
                    }
                }
            }),
        );
        if (deps.signal?.aborted || (selected.length && failed === selected.length)) throw new GovernmentSourceError();
        const seen = new Set<string>();
        result.jobs = observations.filter((job): job is JobsPortalJob => {
            if (!job) return false;
            if (seen.has(job.id)) {
                result.excluded++;
                return false;
            }
            seen.add(job.id);
            return true;
        });
        return result;
    } catch {
        throw new GovernmentSourceError();
    } finally {
        budget.cleanup();
    }
}
