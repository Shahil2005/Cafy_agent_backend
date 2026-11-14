import type { ChatSearch } from './chatIntent';
import type { JobsPortalJob } from './types';

export interface ChatJobMatch {
    matches: boolean;
    /** Short, source-derived reasons only; never a generated suitability score. */
    evidence: string[];
}

function plainText(value: string | null | undefined): string {
    return (value || '')
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/\r/g, '\n');
}

function normalized(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/['\u2018\u2019]/g, '')
        .replace(/\bc\+\+/g, ' cpp ')
        .replace(/\bc#/g, ' csharp ')
        .replace(/\.net\b/g, ' dotnet ')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Whole words prevent Reading ≠ reading-in-description and London ≠ Londonderry. */
export function chatTextContains(value: string, requested: string): boolean {
    const haystack = ` ${normalized(value)} `;
    const needle = normalized(requested);
    return Boolean(needle) && haystack.includes(` ${needle} `);
}

/** Every role token must occur in a title/department, never arbitrary advert prose. */
export function chatRoleMatches(job: Pick<JobsPortalJob, 'title' | 'department'>, role: string): boolean {
    const words = normalized(role).split(' ').filter(Boolean);
    const source = `${normalized(job.title)} ${normalized(job.department || '')}`.split(' ');
    return words.every((word) =>
        source.some(
            (actual) => actual === word || (word.length > 3 && (actual === `${word}s` || word === `${actual}s`)),
        ),
    );
}

function sourceQuote(text: string, match: RegExpMatchArray | null): string | undefined {
    if (!match || match.index === undefined) return undefined;
    const start = Math.max(0, text.lastIndexOf('\n', match.index) + 1, match.index - 90);
    const end = text.indexOf('\n', match.index + match[0].length);
    return text
        .slice(start, end < 0 ? Math.min(text.length, match.index + match[0].length + 110) : Math.min(end, start + 240))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
}

const REMOTE_NEGATIVE =
    /\b(?:no|not|without)\s+(?:(?:a|an)\s+)?(?:fully\s+)?remote\b|\bremote\s+(?:work(?:ing)?\s+)?(?:is\s+)?(?:not\s+(?:(?:an?|the)\s+)?(?:available|possible|permitted|offered|supported|allowed|option)|unavailable)\b|\b(?:cannot|can'?t|unable to)\s+(?:work\s+)?remotely\b/i;
const HYBRID =
    /\bhybrid\s+(?:work(?:ing)?|role|position|job|arrangement|schedule)\b|\b(?:work(?:ing)?\s*(?:arrangement|pattern|model|mode)?\s*[:=-]?|location\s*[:=-]?)\s*hybrid\b/i;
const OFFICE_DAYS =
    /\b\d+\s+days?\s+(?:a|per|each)\s+week\s+(?:in|at|from)\s+(?:the\s+)?office\b|\b(?:required|expected|must)\s+to\s+(?:attend|work\s+(?:in|at))\s+(?:the\s+)?office\b/i;
const REMOTE =
    /\b(?:fully|100\s*%|completely)\s+remote\b|\bremote[- ]first\b|\bremote\s+(?:role|position|job)\b|\bwork(?:ing)?\s+fully\s+remotely\b|\bwork(?:ing)?\s+from\s+home\s+(?:full[- ]time|exclusively|permanently)\b|\b(?:work(?:ing)?\s*(?:arrangement|pattern|model|mode)|location)\s*[:=-]\s*remote\b/i;
const ONSITE =
    /\b(?:on[- ]?site|office[- ]based)\s+(?:work(?:ing)?|role|position|job|arrangement)\b|\bwork(?:ing)?\s+(?:fully\s+)?on[- ]?site\b|\b(?:work(?:ing)?\s*(?:arrangement|pattern|model|mode)|location)\s*[:=-]\s*on[- ]?site\b/i;

function workingArrangementEvidence(
    job: JobsPortalJob,
    requested: ChatSearch['workingArrangement'],
): string | undefined {
    const description = plainText(job.description);
    const location = plainText(job.location);
    const source = `${location}\n${description}`;
    const locationMode = (mode: string) => new RegExp(`(?:^|[|,;()])\\s*${mode}\\s*(?:$|[|,;()])`, 'i').test(location);
    if (requested === 'remote') {
        if (
            REMOTE_NEGATIVE.test(source) ||
            HYBRID.test(source) ||
            OFFICE_DAYS.test(source) ||
            locationMode('hybrid') ||
            /\b(?:remote\s+work(?:ing)?|work(?:ing)?\s+from\s+home)\b[^.\n]{0,70}\b(?:may|might|could|occasionally|sometimes|after probation|one day|\d+\s+days?)\b/i.test(
                source,
            )
        )
            return undefined;
        const match = source.match(REMOTE);
        return match ? sourceQuote(source, match) : locationMode('(?:fully\\s+)?remote') ? location.trim() : undefined;
    }
    if (requested === 'hybrid') {
        if (
            /\b(?:no|not)\s+hybrid\b|\bhybrid\s+(?:working\s+)?(?:is\s+)?not\s+(?:available|offered|possible)\b/i.test(
                source,
            )
        )
            return undefined;
        return sourceQuote(source, source.match(HYBRID)) || (locationMode('hybrid') ? location.trim() : undefined);
    }
    if (requested === 'on-site') {
        if (
            /\b(?:no|not)\s+(?:on[- ]?site|office[- ]based)\b/i.test(source) ||
            HYBRID.test(source) ||
            locationMode('hybrid')
        )
            return undefined;
        return sourceQuote(source, source.match(ONSITE)) || (locationMode('on[- ]?site') ? location.trim() : undefined);
    }
    return undefined;
}

interface AdvertisedPay {
    min?: number;
    max?: number;
    currency: 'GBP' | 'EUR' | 'USD';
    period: 'year' | 'hour' | 'month';
    quote: string;
}

function payPeriod(value: string): AdvertisedPay['period'] | undefined {
    if (/(?:\b(?:per|an?|each)\s+(?:hour|hr)\b|\/\s*(?:hour|hr|h)\b|\bhourly\b|\bp\.?h\.?(?:\s|$))/i.test(value))
        return 'hour';
    if (/(?:\b(?:per|an?|each)\s+month\b|\/\s*(?:month|mo)\b|\bmonthly\b|\bp\.?m\.?(?:\s|$))/i.test(value))
        return 'month';
    if (
        /(?:\b(?:per|an?|each)\s+(?:year|annum)\b|\/\s*(?:year|yr|annum)\b|\bannual(?:ly)?\b|\bp\.?a\.?(?:\s|$))/i.test(
            value,
        )
    )
        return 'year';
    return undefined;
}

function amount(value: string): number | undefined {
    const cleaned = value.replace(/,/g, '').trim().toLowerCase();
    const n = Number.parseFloat(cleaned) * (/k$/.test(cleaned) ? 1000 : 1);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** No annualisation, inferred hours, bonus totals or guessed units. */
export function advertisedChatPay(job: Pick<JobsPortalJob, 'salary' | 'description'>): AdvertisedPay[] {
    const salary = plainText(job.salary);
    const candidates = salary.trim()
        ? [salary]
        : plainText(job.description)
              .split(/\n|(?<=[.;])\s+/)
              .filter((line) =>
                  /\b(?:salary|pay(?:\s+rate)?|remuneration|compensation|hourly\s+rate|annual\s+salary)\b/i.test(line),
              );
    const result: AdvertisedPay[] = [];
    for (const candidate of candidates) {
        // Full-time-equivalent figures cannot establish actual part-time pay without hours.
        if (/\b(?:pro[- ]?rata|fte|full[- ]time equivalent|ote|on[- ]target earnings)\b/i.test(candidate)) continue;
        const period = payPeriod(candidate);
        if (!period) continue;
        const money =
            /(?:£|GBP|€|EUR|\$|USD)\s*(\d[\d,]*(?:\.\d+)?\s*k?)(?:\s*(?:-|to)\s*(?:£|GBP|€|EUR|\$|USD)?\s*(\d[\d,]*(?:\.\d+)?\s*k?))?/gi;
        const values = [...candidate.matchAll(money)];
        // Multiple independent amounts may be bonus, allowances, or mixed currencies.
        if (values.length !== 1) continue;
        const match = values[0]!;
        const token = match[0].trim();
        const currency: AdvertisedPay['currency'] = /^(?:£|GBP)/i.test(token)
            ? 'GBP'
            : /^(?:€|EUR)/i.test(token)
              ? 'EUR'
              : 'USD';
        const currencies = [...token.matchAll(/£|GBP|€|EUR|\$|USD/gi)].map((item) =>
            /^(?:£|GBP)$/i.test(item[0]) ? 'GBP' : /^(?:€|EUR)$/i.test(item[0]) ? 'EUR' : 'USD',
        );
        if (new Set(currencies).size !== 1) continue;
        const lower = amount(match[1]!);
        const upper = match[2] ? amount(match[2]) : lower;
        if (!lower || !upper || lower > upper) continue;
        const before = candidate.slice(Math.max(0, (match.index ?? 0) - 30), match.index).trim();
        result.push({
            ...(!/\b(?:up to|maximum(?:\s+of)?|as much as)\s*$/i.test(before) ? { min: lower } : {}),
            ...(!/\b(?:from|minimum(?:\s+of)?|at least|starting(?:\s+at)?)\s*$/i.test(before) ? { max: upper } : {}),
            currency,
            period,
            quote: candidate.replace(/\s+/g, ' ').trim().slice(0, 240),
        });
    }
    return result;
}

const SPONSORSHIP_NEGATIVE =
    /\b(?:no|without)\s+(?:visa\s+|skilled worker\s+)?sponsorship\b|\b(?:cannot|can'?t|unable to|not able to|will not|won'?t|do not|does not|don'?t|doesn'?t)\s+(?:(?:offer|provide|support|arrange)\s+(?:\w+\s+){0,3})?(?:sponsor(?:ship)?|sponsoring)\b|\b(?:visa\s+)?sponsorship\s+(?:is\s+|will\s+be\s+|can\s+be\s+)?(?:not\s+(?:available|provided|offered|supported|possible)|unavailable)\b|\bsponsorship\s+(?:cannot|can'?t|will not|won'?t)\s+be\s+(?:offered|provided|supported)\b|\bnot\s+eligible\s+for\s+(?:visa\s+)?sponsorship\b/i;
const SPONSORSHIP_POSITIVE =
    /\b(?:visa\s+|skilled worker\s+)?sponsorship\s+(?:is\s+)?(?:available|provided|offered)\b|\b(?:we\s+)?(?:can|will|are able to|able to)\s+(?:(?:offer|provide|arrange)\s+(?:visa\s+)?)?sponsor(?:ship)?\b|\bwe\s+(?:offer|provide)\s+(?:visa\s+|skilled worker\s+)?sponsorship\b/i;

/** Licence, advert policy and personal immigration eligibility remain separate facts. */
export function chatSponsorshipEvidence(job: JobsPortalJob): string | undefined {
    const source = plainText(job.description);
    if (SPONSORSHIP_NEGATIVE.test(source)) return undefined;
    const quote = sourceQuote(source, source.match(SPONSORSHIP_POSITIVE));
    if (
        quote &&
        /\b(?:visa|skilled worker|immigration|certificate of sponsorship|right to work)\b/i.test(quote) &&
        !/\b(?:may|might|could|if|depending|subject to)\b/i.test(quote)
    )
        return quote;
    const assessment = job.sponsorshipAssessment;
    if (
        assessment?.verdict === 'advert_supported' &&
        assessment.sponsorshipPolicy === 'positive' &&
        Date.parse(assessment.expiresAt) > Date.now()
    ) {
        // Assessment alone must not manufacture a quote absent from the current advert.
        return assessment.sponsorshipEvidence.find(
            (item) =>
                item.trim() &&
                source.includes(item.trim()) &&
                /\b(?:visa|skilled worker|immigration|certificate of sponsorship|right to work)\b/i.test(item) &&
                !/\b(?:may|might|could|if|depending|subject to)\b/i.test(item),
        );
    }
    return undefined;
}

const CIVIL_SERVICE_DEPARTMENTS: ReadonlyArray<{ names: string[]; slug: string; hosts?: string[] }> = [
    {
        names: ['Department for Work and Pensions', 'DWP', 'DWP Digital'],
        slug: 'department-for-work-pensions',
        hosts: ['dwp.gov.uk', 'dwpdigital.blog.gov.uk'],
    },
    {
        names: ['Driver and Vehicle Licensing Agency', 'DVLA'],
        slug: 'driver-and-vehicle-licensing-agency',
        hosts: ['dvla.gov.uk'],
    },
    {
        names: ['HM Revenue and Customs', 'HM Revenue & Customs', 'HMRC'],
        slug: 'hm-revenue-customs',
        hosts: ['hmrc.gov.uk'],
    },
    { names: ['Home Office'], slug: 'home-office', hosts: ['homeoffice.gov.uk'] },
    { names: ['Government Digital Service', 'GDS'], slug: 'government-digital-service', hosts: ['gds.blog.gov.uk'] },
    { names: ['Cabinet Office'], slug: 'cabinet-office', hosts: ['cabinetoffice.gov.uk'] },
    { names: ['Department for Education', 'DfE'], slug: 'department-for-education', hosts: ['education.gov.uk'] },
    { names: ['Department for Transport', 'DfT'], slug: 'department-for-transport', hosts: ['dft.gov.uk'] },
    { names: ['Ministry of Justice', 'MoJ'], slug: 'ministry-of-justice', hosts: ['justice.gov.uk'] },
    { names: ['Ministry of Defence', 'MoD'], slug: 'ministry-of-defence', hosts: ['mod.gov.uk'] },
    { names: ['HM Treasury', 'HMT'], slug: 'hm-treasury' },
    { names: ['Office for National Statistics', 'ONS'], slug: 'office-for-national-statistics', hosts: ['ons.gov.uk'] },
    { names: ['HM Land Registry', 'HMLR'], slug: 'land-registry', hosts: ['landregistry.gov.uk'] },
    {
        names: [
            'Department for Science Innovation and Technology',
            'Department for Science, Innovation and Technology',
            'DSIT',
        ],
        slug: 'department-for-science-innovation-and-technology',
    },
    { names: ['Department for Business and Trade', 'DBT'], slug: 'department-for-business-and-trade' },
    { names: ['Department of Health and Social Care', 'DHSC'], slug: 'department-of-health-and-social-care' },
    {
        names: [
            'Department for Environment Food and Rural Affairs',
            'Department for Environment, Food and Rural Affairs',
            'Defra',
        ],
        slug: 'department-for-environment-food-rural-affairs',
    },
];

function officialSourceUrl(value: string | null | undefined): URL | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
            ? url
            : undefined;
    } catch {
        return undefined;
    }
}

/** Institution identity from actual official URLs, never title/advert keyword mentions. */
export function chatCivilServiceEvidence(job: Pick<JobsPortalJob, 'url' | 'company'>): string | undefined {
    const advert = officialSourceUrl(job.url);
    if (
        advert &&
        ['www.civilservicejobs.service.gov.uk', 'civilservicejobs.service.gov.uk'].includes(
            advert.hostname.toLowerCase(),
        ) &&
        advert.pathname === '/csr/jobs.cgi' &&
        /^\d{4,14}$/.test(advert.searchParams.get('jcode') || '')
    )
        return 'Advert source: UK Civil Service Jobs.';
    const identities = [job.company?.trading_name, job.company?.companies_house_name]
        .filter((name): name is string => Boolean(name))
        .map(normalized);
    const sources = [officialSourceUrl(job.company?.url), advert].filter((url): url is URL => Boolean(url));
    for (const department of CIVIL_SERVICE_DEPARTMENTS) {
        if (!department.names.some((name) => identities.includes(normalized(name)))) continue;
        const official = sources.some((url) => {
            const host = url.hostname.toLowerCase();
            return (
                (['www.gov.uk', 'gov.uk'].includes(host) &&
                    url.pathname.replace(/\/+$/, '') === `/government/organisations/${department.slug}`) ||
                department.hosts?.some((domain) => host === domain || host.endsWith(`.${domain}`))
            );
        });
        if (official)
            return `Employer identity: ${job.company!.trading_name}, matched to its official UK government organisation link.`;
    }
    return undefined;
}

export function matchChatJob(job: JobsPortalJob, search: ChatSearch): ChatJobMatch {
    const evidence: string[] = [];
    const fail = (): ChatJobMatch => ({ matches: false, evidence: [] });
    if (search.unsupported?.length) return fail();
    if (search.employerScope === 'civil-service') {
        const source = chatCivilServiceEvidence(job);
        if (!source) return fail();
        evidence.push(source);
    }
    if (search.sponsorship !== 'any' && job.listingSource && job.listingSource.employerLicence !== 'catalogue-match')
        return fail();
    if (search.role) {
        if (!chatRoleMatches(job, search.role)) return fail();
        evidence.push(`Role keywords: ${job.title}${job.department ? ` · ${job.department}` : ''}`);
    }
    if (search.where) {
        if (![job.location, job.city || ''].some((value) => chatTextContains(value, search.where))) return fail();
        evidence.push(`Location: ${job.location || job.city}`);
    }
    if (search.employer) {
        if (
            ![job.company?.trading_name || '', job.company?.companies_house_name || ''].some((value) =>
                chatTextContains(value, search.employer),
            )
        )
            return fail();
        evidence.push(`Employer: ${job.company?.trading_name}`);
    }
    if (search.jobTypes.length) {
        if (!job.jobType || !search.jobTypes.includes(job.jobType as ChatSearch['jobTypes'][number])) return fail();
        evidence.push(`${job.listingSource ? 'Provider' : 'Catalogue'} employment type: ${job.jobType}`);
    }
    if (search.levels.length) {
        if (!job.level || !search.levels.includes(job.level as ChatSearch['levels'][number])) return fail();
        evidence.push(`${job.listingSource ? 'Provider' : 'Catalogue'} experience level classification: ${job.level}`);
    }
    if (search.workingArrangement !== 'any') {
        const quote = workingArrangementEvidence(job, search.workingArrangement);
        if (!quote) return fail();
        evidence.push(`Working arrangement in listing: ${quote}`);
    }
    if (search.salary) {
        const requested = search.salary;
        const satisfies = (value: AdvertisedPay): boolean =>
            value.currency === requested.currency &&
            value.period === requested.period &&
            (requested.min === undefined || (value.min !== undefined && value.min >= requested.min)) &&
            (requested.max === undefined || (value.max !== undefined && value.max <= requested.max));
        const pay = advertisedChatPay(job).find(satisfies);
        if (!pay) return fail();
        const descriptionPay = job.salary?.trim() ? advertisedChatPay({ description: job.description }) : [];
        if (descriptionPay.some((value) => !satisfies(value))) return fail();
        evidence.push(`Advertised pay: ${pay.quote}`);
    }
    if (search.sponsorship === 'licensed-employer') {
        if (!job.company?.licensed_sponsor) return fail();
        evidence.push(
            'Employer is listed as a licensed UK sponsor in CAFY’s catalogue; this does not establish sponsorship for this role.',
        );
    } else if (search.sponsorship === 'advert-confirmed') {
        // A positive advert cannot establish the employer's licensing status.
        // Unknown/unlicensed catalogue employers are deliberately excluded, even
        // when this sacrifices recall; this remains source evidence, not a visa verdict.
        if (!job.company?.licensed_sponsor) return fail();
        const quote = chatSponsorshipEvidence(job);
        if (!quote) return fail();
        evidence.push('Employer is listed as a licensed UK sponsor in CAFY’s catalogue.');
        evidence.push(`Sponsorship wording in advert: ${quote}`);
    }
    return { matches: true, evidence };
}
