import { z } from 'zod';
import { JOBS_SEARCH_QUERY_MAX_LENGTH } from './constants';
import { PART_TIME_UK_CITIES, officialPartTimeCity } from './partTimeCities';

const salarySchema = z
    .object({
        min: z.number().positive().max(10_000_000).optional(),
        max: z.number().positive().max(10_000_000).optional(),
        currency: z.enum(['GBP', 'EUR', 'USD']),
        period: z.enum(['year', 'hour', 'month']),
    })
    .strict()
    .refine(
        (value) =>
            (value.min !== undefined || value.max !== undefined) &&
            (value.min === undefined || value.max === undefined || value.min <= value.max),
        'Provide a valid salary range',
    );
/** Location and employer are independent AND constraints. Defaults accept legacy client searches. */
export const chatSearchSchema = z
    .object({
        role: z.string().trim().max(JOBS_SEARCH_QUERY_MAX_LENGTH),
        where: z.string().trim().max(JOBS_SEARCH_QUERY_MAX_LENGTH),
        kind: z.enum(['career', 'part-time']),
        employer: z.string().trim().max(JOBS_SEARCH_QUERY_MAX_LENGTH).default(''),
        /** Explicit institution scope; not a broad public-sector classification. */
        employerScope: z.enum(['any', 'civil-service']).default('any'),
        jobTypes: z
            .array(z.enum(['Full-time', 'Part-time', 'Contract', 'Internship', 'Placement scheme']))
            .max(5)
            .default([]),
        levels: z
            .array(z.enum(['Entry Level', 'Junior', 'Mid Level', 'Senior']))
            .max(4)
            .default([]),
        workingArrangement: z.enum(['any', 'remote', 'hybrid', 'on-site']).default('any'),
        salary: salarySchema.optional(),
        sponsorship: z.enum(['any', 'licensed-employer', 'advert-confirmed']).default('any'),
        unsupported: z.array(z.string().trim().min(1).max(150)).max(12).default([]),
    })
    .strict();
export const jobChatInputSchema = z
    .object({
        message: z.string().trim().min(1).max(2000),
        history: z
            .array(
                z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) }).strict(),
            )
            .max(8)
            .default([]),
        search: chatSearchSchema.optional(),
        includeWeb: z.boolean().optional(),
    })
    .strict();
export type ChatSearch = z.infer<typeof chatSearchSchema>;
export type JobChatInput = z.infer<typeof jobChatInputSchema>;
export interface ChatIntent {
    search: ChatSearch;
    notes: string[];
    clarification?: string;
    requiresClarification?: boolean;
}
const emptySearch = (): ChatSearch => chatSearchSchema.parse({ role: '', where: '', kind: 'career' });
const SECTOR =
    /\b(?:(?:in|within|across|from|for)\s+)?(?:the\s+)?(?:public(?:\s+and\s+private)?|private(?:\s+and\s+public)?)[ -]sectors?\b/gi;
function compact(value: string): string {
    return value
        .replace(/\s+/g, ' ')
        .replace(/^[\s,;:.!?–—-]+|[\s,;:.!?–—-]+$/g, '')
        .trim();
}
function cityName(raw: string): string | undefined {
    return (
        PART_TIME_UK_CITIES.find((city) => city.toLowerCase() === raw.toLowerCase()) ||
        officialPartTimeCity(raw.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())) ||
        undefined
    );
}
export function normalizeChatWhere(raw: string): string {
    const national = compact(raw.replace(/\b(?:instead|please|only|for me)\b/gi, ''));
    if (/^(?:the\s+)?(?:anywhere|everywhere|all locations?|all cities|uk|united kingdom|britain)$/i.test(national))
        return '';
    const value = compact(
        raw
            .replace(/\b(?:instead|please|only|for me)\b/gi, '')
            .replace(/,?\s+(?:uk|united kingdom|england|scotland|wales|northern ireland)$/i, '')
            .replace(/(?:\s+(?:and|with|but|for))+\s*$/i, ''),
    );
    if (/^(?:the\s+)?(?:anywhere|everywhere|all locations?|all cities|uk|united kingdom|britain)$/i.test(value))
        return '';
    return (cityName(value) || value).slice(0, JOBS_SEARCH_QUERY_MAX_LENGTH);
}
function unsupportedRequirements(text: string): string[] {
    const requirements: string[] = [];
    const add = (test: RegExp, label: string) => {
        if (test.test(text)) requirements.push(label);
    };
    add(
        /\b(?:public(?:\s+and\s+private)?|private(?:\s+and\s+public)?)[ -]sectors?\b/i,
        'public/private sector classification',
    );
    add(/\b(?:near me|commut\w*|within\s+\d+|\d+\s*(?:miles?|km|minutes?|mins?))\b/i, 'commute distance or time');
    add(/\b(?:weekends?|evenings?|night shifts?|\d+\s*(?:hours?|hrs?))\b/i, 'specific working hours');
    add(
        /\b(?:\d+\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s*(?:experience)?|no experience(?:\s+(?:needed|required))?)\b/i,
        'exact experience requirements',
    );
    add(
        /\b(?:not|excluding|except|no)\s+(?:fully\s+)?(?:remote|hybrid|on[- ]site)\b/i,
        'excluding a working arrangement',
    );
    add(
        /\b(?:not|excluding|except|no)\s+(?:full[- ]time|part[- ]time|contracts?|internships?|placements?)\b/i,
        'excluding a job type',
    );
    add(
        /\b(?:not|excluding|except|no)\s+(?:senior|junior|graduate|entry[- ]level|mid[- ]level)\b/i,
        'excluding an experience level',
    );
    add(/\b(?:excluding|except|not at|not in)\s+\w+/i, 'excluding an employer or location');
    add(
        /\b(?:exclude|excluding|not|no|without)\s+(?:the\s+)?civil[ -]*service\b/i,
        'excluding Civil Service employers',
    );
    add(/\b(?:without|no|not)\s+(?:visa\s+)?sponsorship\b/i, 'excluding sponsorship');
    add(/\b(?:not|without)\s+(?:under|over|below|above|less|more)\b/i, 'a negated salary threshold');
    add(
        /\b(?:(?:do not|don't|don’t|cannot|can't|won't|will not)\s+(?:(?:want|show|include|find|need|accept)\s+)?|exclude\s+)(?:(?:any|the|fully)\s+)?(?:remote|hybrid|on[- ]site|full[- ]time|part[- ]time|contracts?|senior|junior|sponsorship)\b/i,
        'a negated filter requirement',
    );
    add(
        /\b\d+\s*h(?:\/|\s+per\s*)(?:week|wk|day)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty)\s+hours?\b|\b(?:term[- ]time|weekdays?|monday to friday|day shifts?)\b/i,
        'specific working hours',
    );
    add(
        /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+years?(?:\s+of)?\s+experience\b/i,
        'exact experience requirements',
    );
    add(/\b(?:permanent|temporary|fixed[- ]term)\b/i, 'permanent or temporary contract status');
    add(
        /\b(?:right to work|soc codes?|visa eligibility|eligible for (?:a )?visa)\b/i,
        'personal immigration eligibility',
    );
    return [...new Set(requirements)];
}
/** Unsupported requirements cause clarification, never a silently broader search. */
export function unsupportedChatNotes(text: string): string[] {
    return unsupportedRequirements(text).map(
        (requirement) => `I need clarification about ${requirement}; it cannot be verified by this search.`,
    );
}
function cleanRole(raw: string): string {
    const cleaned = compact(raw)
        .replace(
            /^(?:(?:hi|hello|hey)[,!]?\s*)?(?:(?:please\s+)?(?:can|could|would) you\s+)?(?:please\s+)?(?:(?:find|show|search|look for|give)(?:\s+me)?(?:\s+for)?|i(?:'m| am) looking for|i want|i need|what about|how about|actually|only)\s*/i,
            '',
        )
        .replace(/\b(?:UK|British|Irish|Ireland|United Kingdom|Britain)\s+(?=(?:jobs?|roles?|vacanc(?:y|ies))\b)/gi, '')
        .replace(/\b(?:jobs?|roles?|vacanc(?:y|ies)|positions?|opportunities|please|instead|for me)\b/gi, ' ')
        .replace(/\b(?:same|these|those|them|the same|same as before|only|also|too|now)\b/gi, ' ')
        .replace(/\b(?:make it|make them|that offer|offering|requiring)\b/gi, ' ')
        .replace(/^(?:some|any|all|a|an|the)\s+/i, '');
    return compact(
        compact(cleaned).replace(
            /^(?:(?:and|but|with|for|that|are|is|be|make|it|them|to|in|at|near|around|of|needing|requiring)\s+)+|(?:\s+(?:and|but|with|for|that|are|is|be|make|it|them|to|in|at|near|around|of|needing|requiring))+$/gi,
            '',
        ).replace(/^(?:some|any|all|a|an|the)\s+/i, ''),
    ).slice(0, JOBS_SEARCH_QUERY_MAX_LENGTH);
}
function parseSalary(text: string): { salary?: ChatSearch['salary']; text: string; mentioned: boolean } {
    text = text
        .replace(/\bhourly\b/gi, 'per hour')
        .replace(/\bannually\b/gi, 'per year')
        .replace(/\bmonthly\b/gi, 'per month');
    const number = '(?:(?:[£€$]|GBP|EUR|USD)\\s*)?\\d[\\d,]*(?:\\.\\d+)?\\s*[kK]?';
    const range = new RegExp(
        `(?:(?:salary|pay(?:ing)?|earn(?:ing)?|between|from)\\s*(?:of\\s*)?)?(${number})\\s*(?:-|–|—|to|and)\\s*(${number})(?:\\s*(?:per|a|an|\\/)\\s*(hour|hr|year|annum|month)|\\s*(pa|p\\.a\\.|ph))?`,
        'i',
    );
    const single = new RegExp(
        `(?:(?:salary|pay(?:ing)?|earn(?:ing)?)\\s*(?:of\\s*)?)?((?:at least|at most|no less than|no more than|more than|less than|greater than|higher than|lower than|over|above|under|below|minimum(?: of)?|maximum(?: of)?|up to|from)\\s*)?(${number})(\\s*\\+)?(?:\\s*(?:per|a|an|\\/)\\s*(hour|hr|year|annum|month)|\\s*(pa|p\\.a\\.|ph))?`,
        'i',
    );
    const mentioned =
        /[£€$]|\b(?:GBP|EUR|USD)\s*\d|\b\d+(?:\.\d+)?k\b|\b(?:salary|paying|paid|per hour|per annum|per month)\b/i.test(
            text,
        );
    if (!mentioned) return { text, mentioned: false };
    const rangeMatch = range.exec(text);
    const match = rangeMatch || single.exec(text);
    if (
        !match ||
        !/[£€$]|\b(?:GBP|EUR|USD)\b|\d\s*k\b|\b(?:salary|pay|paying|earn|earning|hour|hr|year|annum|month|pa|ph)\b/i.test(
            match[0],
        )
    )
        return { text, mentioned };
    const rawA = rangeMatch ? match[1]! : match[2]!;
    const rawB = rangeMatch ? match[2]! : undefined;
    const currencies = [
        ...new Set(
            [rawA, rawB]
                .filter((value): value is string => Boolean(value))
                .map((value) =>
                    /€|EUR/i.test(value) ? 'EUR' : /\$|USD/i.test(value) ? 'USD' : /£|GBP/i.test(value) ? 'GBP' : null,
                )
                .filter(Boolean),
        ),
    ];
    if (currencies.length > 1) return { text, mentioned };
    const amount = (value: string, inheritK: boolean) =>
        Number(value.replace(/[^\d.]/g, '')) * (/k/i.test(value) || inheritK ? 1000 : 1);
    const suffix = rangeMatch ? match[3] || match[4] : match[4] || match[5];
    const period = /^(?:hour|hr|ph)$/i.test(suffix || '') ? 'hour' : /^month$/i.test(suffix || '') ? 'month' : 'year';
    const a = amount(rawA, Boolean(rawB && /k/i.test(rawB) && Number(rawA.replace(/[^\d.]/g, '')) < 1000));
    const b = rawB ? amount(rawB, /k/i.test(rawA) && Number(rawB.replace(/[^\d.]/g, '')) < 1000) : undefined;
    if (!suffix && a < 1000) return { text, mentioned };
    const trailingComparison = !rangeMatch
        ? /^\s+(or more|or less|and above|and below)\b/i.exec(text.slice(match.index + match[0].length))
        : null;
    const direction = rangeMatch
        ? ''
        : (
              match[1] ||
              (trailingComparison ? (/more|above/i.test(trailingComparison[1]!) ? 'at least' : 'at most') : '')
          ).trim();
    const strictLower = /^(?:over|above|more than|greater than|higher than)$/i.test(direction);
    const strictUpper = /^(?:under|below|less than|lower than)$/i.test(direction);
    const lower = strictLower ? Number((a + 0.01).toFixed(2)) : a;
    const upper = strictUpper ? Number((a - 0.01).toFixed(2)) : a;
    const candidate = {
        currency: currencies[0] || 'GBP',
        period,
        ...(b !== undefined
            ? { min: a, max: b }
            : /^(?:under|below|at most|maximum|up to|less than|lower than|no more than)/i.test(direction)
              ? { max: upper }
              : /^(?:over|above|at least|minimum|from|more than|greater than|higher than|no less than)/i.test(
                      direction,
                  ) || Boolean(!rangeMatch && match[3])
                ? { min: lower }
                : { min: a, max: a }),
    };
    const parsed = salarySchema.safeParse(candidate);
    if (!parsed.success) return { text, mentioned };
    return {
        salary: parsed.data,
        text:
            text.slice(0, match.index) +
            ' ' +
            text.slice(match.index + match[0].length + (trailingComparison?.[0].length || 0)),
        mentioned,
    };
}
/** Protect explicit employer names before interpreting words such as Senior or Full Time as filters. */
function extractEmployer(text: string): { value: string; rest: string; alternatives: boolean } | undefined {
    const match =
        /\b(?:at(?!\s+(?:least|most)\b)|for employer|with employer|employer:?|company:?|(?:jobs?|roles?)\s+for)\s+(?:the\s+)?(.+?)(?=\s+(?:based in|located in|in|near|around|paying|earning|with salary|with pay|with visa|with sponsorship|offering sponsorship|working remotely|working hybrid|fully remote|remote(?: only| working)?$|hybrid(?: only| working)?$|(?:with|and|for|that are) (?:remote|hybrid|on[- ]site|full[- ]time|part[- ]time|contracts?|internships?|entry[- ]level|junior|senior))\b|[,;]|$)/i.exec(
            text,
        );
    if (match) {
        const value = compact(
            match[1]!.replace(/\b(?:instead|only|please)\b/gi, '').replace(/(?:\s+(?:and|but))+$/i, ''),
        );
        const forPhrase = /^(?:jobs?|roles?)\s+for\b/i.test(match[0]);
        const looksLikeEmployer =
            !forPhrase ||
            (/^[A-Z]/.test(value) &&
                !/\b(?:analysts?|developers?|engineers?|managers?|students?|graduates?)\b/i.test(value));
        if (
            looksLikeEmployer &&
            !unsupportedRequirements(value).length &&
            value &&
            !/^(?:(?:licensed|licen[cs]e[- ]holding)\s+(?:visa\s+)?sponsors?|sponsors?|least|most|filter|students?|graduates?|me|you|us|a|an|the)$/i.test(
                value,
            )
        ) {
            return {
                value: value.slice(0, JOBS_SEARCH_QUERY_MAX_LENGTH),
                rest: text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length),
                alternatives: /\bor\b/i.test(value),
            };
        }
    }
    const nhs = /\b(?:(?:at|for|with)\s+)?(?:the\s+)?nhs\b/i.exec(text);
    if (nhs)
        return {
            value: 'NHS',
            rest: text.slice(0, nhs.index) + ' ' + text.slice(nhs.index + nhs[0].length),
            alternatives: false,
        };
    return undefined;
}
/** Consume explicit broadening before a mentioned institution can narrow the search again. */
function broadenEmployers(text: string, search: ChatSearch): string {
    const unrestricted = (pattern: RegExp) => {
        if (!pattern.test(text)) return false;
        search.employer = '';
        search.employerScope = 'any';
        text = text.replace(pattern, ' ');
        return true;
    };
    const employers = ['(?:(?:uk|british)\\s+)?civil[ -]*service'];
    if (search.employer)
        employers.push(search.employer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    for (const employer of employers) {
        const name = `(?:the\\s+)?(?:${employer})(?:\\s+(?:jobs?|roles?|employers?))?`;
        unrestricted(
            new RegExp(
                `\\b(?:not\\s+(?:only|just)(?:\\s+(?:in|at|for|within|from))?|not\\s+(?:restricted|limited|confined)\\s+to|beyond)\\s+${name}(?=\\s|[,;:.!?–—-]|$)`,
                'gi',
            ),
        );
        unrestricted(new RegExp(`\\bnot\\s+${name}\\s+only\\b`, 'gi'));
    }
    return text;
}
/** Called after employer extraction so employer names are never interpreted as sector filters. */
function broadenEmployerSectors(text: string, search: ChatSearch): string {
    return text.replace(
        /\b(?:(?:in|within|across|from|for)\s+)?(?:(?:any|all)(?:\s+the)?\s+(?:sectors?|industries)|(?:both\s+)?(?:public\s+and\s+private|private\s+and\s+public)[ -]sectors?)\b/gi,
        (phrase: string, offset: number) => {
            if (/\b(?:not|no|excluding|except|without)(?:\s+(?:in|within|across|from|for))?\s*$/i.test(text.slice(0, offset))) {
                search.unsupported.push('excluding an employer sector');
                return phrase;
            }
            search.employer = '';
            search.employerScope = 'any';
            search.unsupported = search.unsupported.filter((value) => value !== 'public/private sector classification');
            return ' ';
        },
    );
}
function applyMessage(message: string, previous: ChatSearch): ChatSearch {
    let text = compact(message);
    if (/^(?:start over|reset(?: search)?|new search)[.!]?$/i.test(text)) return emptySearch();
    const search = chatSearchSchema.parse(previous);
    // Repair older conversations which stored an institution as occupation keywords.
    if (/\bcivil[ -]*service\b/i.test(search.role)) {
        search.employerScope = 'civil-service';
        search.role = compact(search.role.replace(/\b(?:(?:uk|british)\s+)?civil[ -]*service\b/gi, ' '));
    }
    text = broadenEmployers(text, search);
    const clear = (pattern: RegExp, action: () => void) => {
        if (pattern.test(text)) {
            action();
            text = text.replace(pattern, ' ');
        }
    };
    clear(
        /\b(?:(?:remove|clear|drop|ignore)(?: the)? salary(?: filter| preference| requirement)?|any salary|no salary (?:filter|preference|requirement)|remove (?:the )?salary (?:filter|requirement))\b/gi,
        () => {
            delete search.salary;
        },
    );
    clear(
        /\b(?:(?:remove|clear|drop|ignore)(?: the)? location(?: filter| preference| requirement)?|any location|anywhere|all locations?|all cities|no location (?:filter|preference))\b/gi,
        () => {
            search.where = '';
        },
    );
    clear(
        /\b(?:(?:remove|clear|drop|ignore)(?: the)? (?:employer|company)(?: filter| preference| requirement)?|any employer|all employers|any company|no employer (?:filter|preference))\b/gi,
        () => {
            search.employer = '';
            search.employerScope = 'any';
        },
    );
    clear(
        /\b(?:no civil[ -]*service filter|(?:remove|clear|drop)(?: the)? civil[ -]*service (?:filter|scope|requirement))\b/gi,
        () => {
            search.employerScope = 'any';
        },
    );
    clear(
        /\b(?:(?:remove|clear|drop|ignore)(?: the)? (?:experience )?level(?: filter| preference| requirement)?|any (?:experience )?level|all (?:experience )?levels|no (?:experience )?level filter)\b/gi,
        () => {
            search.levels = [];
        },
    );
    clear(
        /\b(?:(?:remove|clear|drop|ignore)(?: the)? job type(?: filter| preference| requirement)?|any job type|all job types|no job type filter)\b/gi,
        () => {
            search.jobTypes = [];
        },
    );
    clear(
        /\b(?:(?:remove|clear|drop|ignore)(?: the)? (?:working arrangement|remote)(?: filter| preference| requirement)?|any working arrangement|any work arrangement|no (?:remote|working arrangement) filter)\b/gi,
        () => {
            search.workingArrangement = 'any';
        },
    );
    clear(
        /\b(?:no sponsorship (?:needed|required|filter)|(?:do not|don't|don’t) need (?:visa )?sponsorship|any sponsorship status|remove sponsorship (?:filter|requirement))\b/gi,
        () => {
            search.sponsorship = 'any';
        },
    );
    clear(
        /\b(?:remove unsupported filters|ignore unsupported (?:filters|requirements)|no unsupported filters)\b/gi,
        () => {
            search.unsupported = [];
        },
    );
    const negated = unsupportedRequirements(text).filter((reason) => /^(?:excluding |a negated )/.test(reason));
    if (negated.length) {
        search.unsupported = [...new Set([...search.unsupported, ...negated])];
        return search;
    }
    if (/\bcivil[ -]*service\b/i.test(text)) {
        search.employerScope = 'civil-service';
        text = text.replace(
            /\b(?:(?:at|in|for|within|across)\s+(?:the\s+)?)?(?:(?:uk|british)\s+)?civil[ -]*service\b/gi,
            ' ',
        );
    }
    const explicitEmployer = extractEmployer(text);
    let employerMentioned = Boolean(explicitEmployer);
    if (explicitEmployer) {
        if (explicitEmployer.alternatives) search.unsupported.push('multiple alternative employers');
        else if (cityName(explicitEmployer.value)) search.where = cityName(explicitEmployer.value)!;
        else search.employer = explicitEmployer.value;
        text = explicitEmployer.rest;
    }
    text = broadenEmployerSectors(text, search);
    const currentUnsupported = unsupportedRequirements(text);
    search.unsupported = [...new Set([...search.unsupported, ...currentUnsupported])];
    if (currentUnsupported.some((reason) => /^(?:excluding |a negated )/.test(reason))) return search;
    text = text
        .replace(SECTOR, ' ')
        .replace(/\bwithin\s+\d+\s*(?:miles?|km|minutes?|mins?)\s*(?:of\s+)?/gi, 'in ')
        .replace(
            /\b(?:(?:within\s+)?\d+\s*(?:miles?|km|minutes?|mins?|hours?|hrs?|years?|yrs?)|near me|commut\w*|weekends?|evenings?|night shifts?|no experience(?:\s+(?:needed|required))?)\b/gi,
            ' ',
        )
        .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+years?(?:\s+of)?\s+experience\b/gi, ' ')
        .replace(/\b(?:for\s+)?\d+\s*h(?:\/|\s+per\s*)(?:week|wk|day)\b/gi, ' ')
        .replace(
            /\b(?:for\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty)\s+hours?(?:\s+(?:a|per)\s+(?:week|day))?\b/gi,
            ' ',
        )
        .replace(/\b(?:during\s+)?(?:term[- ]time|weekdays?|monday to friday|day shifts?)\b/gi, ' ')
        .replace(/\b(?:of\s+)?experience\b/gi, ' ');
    const salary = parseSalary(text);
    text = salary.text;
    if (salary.salary) search.salary = salary.salary;
    else if (salary.mentioned) search.unsupported.push('an unparsed salary requirement');
    text = text.replace(/\b(?:salary|paying|paid|with pay|per annum|per hour|competitive|negotiable)\b/gi, ' ');
    const arrangements = [
        ...new Set(
            [...text.matchAll(/\b(?:remote|hybrid|on[- ]site|work from home|wfh)\b/gi)].map((match) =>
                /hybrid/i.test(match[0]) ? 'hybrid' : /on[- ]site/i.test(match[0]) ? 'on-site' : 'remote',
            ),
        ),
    ];
    if (arrangements.length && !search.unsupported.includes('excluding a working arrangement')) {
        if (arrangements.length > 1) search.unsupported.push('multiple working arrangements');
        else search.workingArrangement = arrangements[0] as ChatSearch['workingArrangement'];
    }
    text = text.replace(
        /\b(?:fully|only|preferably)?\s*(?:remote|hybrid|on[- ]site|work from home|wfh)(?:\s+working)?\b/gi,
        ' ',
    );
    if (
        /\b(?:licensed|licen[cs]e[- ]holding|licen[cs]ed)\s+(?:visa\s+)?sponsors?\b|\bsponsor(?:ship)? licen[cs]e\b/i.test(
            text,
        )
    )
        search.sponsorship = 'licensed-employer';
    else if (/\b(?:sponsor\w*|visa sponsorship)\b/i.test(text) && !search.unsupported.includes('excluding sponsorship'))
        search.sponsorship = 'advert-confirmed';
    text = text.replace(
        /\b(?:(?:with|offering|that offer|requiring|need|needs|i need)\s+)?(?:(?:a\s+)?(?:licensed|licen[cs]e[- ]holding)\s+)?(?:visa\s+)?sponsor\w*(?:\s+licen[cs]e)?\b/gi,
        ' ',
    );
    const contractTitles: string[] = [];
    text = text.replace(
        /\bcontracts?\s+(?:managers?|management|administrators?|administration|specialists?|officers?|negotiators?)\b/gi,
        (value) => {
            contractTitles.push(value);
            return `__occupation${contractTitles.length - 1}__`;
        },
    );
    const types: ChatSearch['jobTypes'] = [];
    const typePatterns: Array<[RegExp, ChatSearch['jobTypes'][number]]> = [
        [/\bfull[- ]time\b/gi, 'Full-time'],
        [/\bpart[- ]time\b/gi, 'Part-time'],
        [/\bcontracts?(?:ing)?\b/gi, 'Contract'],
        [/\binternships?\b/gi, 'Internship'],
        [/\bplacements?(?:\s+schemes?)?\b/gi, 'Placement scheme'],
    ];
    for (const [pattern, type] of typePatterns)
        if (pattern.test(text)) {
            types.push(type);
            text = text.replace(pattern, ' ');
        }
    if (types.length && !search.unsupported.includes('excluding a job type')) {
        search.jobTypes = types;
        const kind = types.length === 1 && types[0] === 'Part-time' ? 'part-time' : 'career';
        if (kind !== search.kind && /\b(?:find|show|search|look for)\b/i.test(message) && !/\bsame\b/i.test(message))
            search.role = '';
        search.kind = kind;
    }
    if (/\bcareer\b/i.test(text)) {
        search.kind = 'career';
        text = text.replace(/\bcareer\b/gi, ' ');
    }
    const levels: ChatSearch['levels'] = [];
    const levelPatterns: Array<[RegExp, ChatSearch['levels'][number]]> = [
        [/\b(?:graduates?(?:\s+schemes?)?|entry[- ]level)\b/gi, 'Entry Level'],
        [/\bjunior\b/gi, 'Junior'],
        [/\bmid(?:dle)?[- ]level\b/gi, 'Mid Level'],
        [/\bsenior\b/gi, 'Senior'],
    ];
    for (const [pattern, level] of levelPatterns)
        if (pattern.test(text)) {
            levels.push(level);
            text = text.replace(pattern, ' ');
        }
    if (levels.length && !search.unsupported.includes('excluding an experience level')) search.levels = levels;
    const skillRequirement =
        /\b(?:with|using|requiring|knowledge of|skills? in|experience in|must have)\s+(?!and\b|but\b|only\b)([a-z0-9][^,;]*?)(?=\s+(?:based in|located in|in|at)\b|[,;]|$)/i;
    if (skillRequirement.test(text)) {
        search.unsupported.push('specific skill or qualification requirements');
        text = text.replace(skillRequirement, ' ');
    }
    text = text.replace(/__occupation(\d+)__/g, (_, index) => contractTitles[Number(index)]!);
    if (/\bnhs\b/i.test(text)) {
        search.employer = 'NHS';
        employerMentioned = true;
        text = text.replace(/\b(?:at|for|with)?\s*(?:the\s+)?nhs\b/gi, ' ');
    }
    const location = /\b(?:based in|located in|in|near|around)\s+(.+?)(?=[,;]|$)/i.exec(text);
    if (location) {
        const value = normalizeChatWhere(location[1]!);
        if (/\b(?:or|and)\b/i.test(value) && !cityName(value)) search.unsupported.push('multiple locations');
        else search.where = value;
        text = text.slice(0, location.index) + ' ' + text.slice(location.index + location[0].length);
    } else {
        const standalone = normalizeChatWhere(
            text.replace(/^(?:what about|how about|same (?:jobs|roles)(?: but)?)\s+/i, ''),
        );
        if (cityName(standalone)) {
            search.where = cityName(standalone)!;
            text = '';
        }
    }
    const role = cleanRole(text);
    if (/\w+\s+or\s+\w+/i.test(role)) search.unsupported.push('multiple alternative roles');
    if (
        role &&
        !/^(?:i|i am|i'm|we|we are|more|continue|yes|thanks|thank you|help|hello|hi|hey|or|and|but|not|no|the|for|from|with|at|in|near|around|that offer|offering|requiring|need|needs|i need|work|working)$/i.test(
            role,
        )
    )
        search.role = role;
    else if (employerMentioned && /\b(?:find|show|search|jobs?|roles?)\b/i.test(message) && !/\bsame\b/i.test(message))
        search.role = '';
    search.unsupported = [...new Set(search.unsupported)].slice(0, 12);
    return search;
}
export function interpretJobChatRules(input: JobChatInput): ChatIntent {
    let search = input.search ? chatSearchSchema.parse(input.search) : emptySearch();
    if (!input.search)
        for (const item of input.history) if (item.role === 'user') search = applyMessage(item.content, search);
    if (
        /^(?:(?:please\s+)?(?:show|find|give|load)(?:\s+me)?\s+)?(?:more(?:\s+(?:results|jobs|roles|listings|like these))?|(?:the\s+)?next(?:\s+(?:page|results|jobs|roles))?|page\s+\d+)(?:\s+please)?[.!]?$/i.test(
            input.message.trim(),
        )
    ) {
        return {
            search,
            notes: [],
            requiresClarification: true,
            clarification:
                'This chat currently shows one results page. Refine the filters for a different search, or use the jobs portal for further browsing.',
        };
    }
    const previous = search;
    const background =
        /^(?:i(?:'m| am) (?:a|an) |i have (?:a |an |\d+ |one |two |three |four |five )|my (?:background|degree)\b)/i.test(
            input.message.trim(),
        );
    const requestedClause = background
        ? /\b(?:looking for|seeking|(?:and\s+)?(?:i\s+)?(?:need|want|would like))\s+(.+)$/i.exec(input.message)?.[1]
        : undefined;
    search = applyMessage(requestedClause || input.message, search);
    const unspecifiedBackground =
        background && (!requestedClause || !cleanRole(requestedClause.replace(/\b(?:in|at|near|around)\s+.*$/i, '')));
    const broad =
        unspecifiedBackground ||
        (/\b(?:i(?:'m| am) a|my background|my degree|what (?:can|should) i|help me (?:choose|find a career)|recommend|suitable|best fit)\b/i.test(
            input.message,
        ) &&
            !/\b(?:jobs?|roles?)\s+(?:in|at)\b/i.test(input.message));
    if (broad) search = previous;
    const meaningful = Boolean(
        search.role ||
        search.where ||
        search.employer ||
        search.employerScope !== 'any' ||
        search.jobTypes.length ||
        search.levels.length ||
        search.workingArrangement !== 'any' ||
        search.salary ||
        search.sponsorship !== 'any',
    );
    const clarification = search.unsupported.length
        ? `I cannot reliably verify ${search.unsupported.join(', ')} from this catalogue. Please clarify the requirement, or choose “Remove unsupported filters” to search using the other criteria. I will not silently ignore it.`
        : broad || !meaningful
          ? 'What job title or type of work would you like to explore, and in which city? For example, “data analyst jobs in London”.'
          : undefined;
    const notes: string[] = [];
    if (search.salary)
        notes.push(
            `Salary matching uses ${search.salary.currency} per ${search.salary.period}; change the amount, currency or pay period if that is not what you intended.`,
        );
    if (search.sponsorship === 'licensed-employer')
        notes.push(
            'A sponsor licence belongs to the employer; it does not establish that this vacancy offers sponsorship or that you qualify.',
        );
    if (search.sponsorship === 'advert-confirmed')
        notes.push(
            'Sponsorship filtering requires positive evidence in the advert. It is not a decision about your personal visa eligibility.',
        );
    return { search, notes, ...(clarification ? { clarification, requiresClarification: true } : {}) };
}
export const modelChatIntentSchema = chatSearchSchema.extend({ needsClarification: z.boolean() }).strict();
/** Remove conversational filler, retaining every substantive role word. No occupation inference. */
function roleWords(role: string): string[] {
    const filler = new Set([
        'i',
        'im',
        'am',
        'would',
        'like',
        'want',
        'need',
        'love',
        'looking',
        'look',
        'find',
        'show',
        'me',
        'my',
        'some',
        'any',
        'a',
        'an',
        'the',
        'job',
        'jobs',
        'role',
        'roles',
        'work',
        'please',
        'can',
        'could',
        'you',
        'help',
        'for',
        'as',
        'that',
        'are',
        'is',
        'to',
        'opportunity',
        'opportunities',
        'seeking',
        'seek',
        'search',
        'searching',
        'interested',
        'in',
        'career',
        'hello',
        'hi',
        'hey',
    ]);
    return (role.toLowerCase().match(/[a-z0-9+#.]+/g) || [])
        .filter((word) => !filler.has(word))
        .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
        .sort();
}
export type NormalizedChatIntent = z.infer<typeof modelChatIntentSchema> & { clarification?: string };

/** A model can identify a possible entity reading; the student confirms it before any filters change. */
function groundedEntityClarification(
    proposed: z.infer<typeof modelChatIntentSchema>,
    input: JobChatInput,
    baseline: ChatSearch,
): string | undefined {
    const employer = proposed.employer && proposed.employer !== baseline.employer ? proposed.employer : '';
    const where = proposed.where && proposed.where !== baseline.where ? normalizeChatWhere(proposed.where) : '';
    if (!employer && !where) return undefined;
    const literal = (value: string) => {
        const words = value
            .toLowerCase()
            .replace(/[^a-z0-9+#]+/g, ' ')
            .trim();
        const request = input.message
            .toLowerCase()
            .replace(/[^a-z0-9+#]+/g, ' ')
            .trim();
        return Boolean(words && ` ${request} `.includes(` ${words} `));
    };
    if ((employer && !literal(employer)) || (where && !literal(where))) return undefined;
    // Do not reinterpret ordinary occupations as employers, even if a model proposes one.
    if (
        employer &&
        /\b(?:analysts?|engineers?|developers?|nurses?|doctors?|managers?|assistants?|administrators?|officers?|consultants?|technicians?|accountants?|lawyers?|solicitors?|teachers?|tutors?|researchers?|scientists?|designers?|architects?|recruiters?|coordinators?|specialists?|drivers?|chefs?|waiters?|waitresses?|baristas?|carers?|cleaners?|pharmacists?|physiotherapists?|dentists?|paramedics?|therapists?|psychologists?|plumbers?|electricians?|surveyors?|operators?|directors?|supervisors?)\b/i.test(
            employer,
        )
    )
        return undefined;
    const originalWords = roleWords(baseline.role);
    const accountedWords = [...roleWords(proposed.role), ...roleWords(employer), ...roleWords(where)].sort();
    if (!originalWords.length || JSON.stringify(originalWords) !== JSON.stringify(accountedWords)) return undefined;
    const confirmedEmployer = employer || baseline.employer;
    const confirmedWhere = where || baseline.where;
    const command = `Find ${proposed.role ? `${proposed.role} jobs` : 'jobs'}${confirmedEmployer ? ` at ${confirmedEmployer}` : ''}${confirmedWhere ? ` in ${confirmedWhere}` : ''}`;
    const reading = [employer ? `“${employer}” as the employer` : '', where ? `“${where}” as the location` : '']
        .filter(Boolean)
        .join(' and ');
    return `Do you mean ${reading}? To confirm, say “${command}”. I have kept your current filters until you confirm.`;
}
/** Models may clean new role wording and discover unsupported requirements, never broaden active filters. */
export function normalizeInterpretedChatIntent(
    intent: z.infer<typeof modelChatIntentSchema>,
    input: JobChatInput,
    baseline: ChatIntent,
): NormalizedChatIntent | null {
    const parsed = modelChatIntentSchema.safeParse(intent);
    if (!parsed.success) return null;
    const result = chatSearchSchema.parse(baseline.search);
    const previousRole = input.search?.role;
    // On filter-only turns, even a plausible model rewrite must preserve the previously chosen role.
    const hasNewRole = Boolean(result.role && (previousRole === undefined || result.role !== previousRole));
    const modelRole = parsed.data.role.trim();
    if (hasNewRole && modelRole && !baseline.requiresClarification) {
        const baselineWords = roleWords(result.role);
        const proposedWords = roleWords(modelRole);
        if (baselineWords.length && JSON.stringify(baselineWords) === JSON.stringify(proposedWords))
            result.role = modelRole;
    }
    const clarification =
        hasNewRole && !baseline.requiresClarification
            ? groundedEntityClarification(parsed.data, input, baseline.search)
            : undefined;
    // Never echo arbitrary provider prose as a purported requirement. Unknown
    // discoveries still trigger clarification, using a server-owned label.
    const modelRequirements = parsed.data.unsupported.map((requirement) =>
        /^(?:a )?professional registration requirement$/i.test(requirement)
            ? 'a professional registration requirement'
            : result.unsupported.includes(requirement)
              ? requirement
              : 'an additional requirement that needs clarification',
    );
    result.unsupported = [...new Set([...result.unsupported, ...modelRequirements])].slice(0, 12);
    return {
        ...result,
        ...(clarification ? { clarification } : {}),
        needsClarification: Boolean(
            clarification || baseline.clarification || parsed.data.needsClarification || result.unsupported.length,
        ),
    };
}
/** JSON query data only: no generated jobs, links, prose or eligibility claims. */
export function parseModelChatIntent(text: string): z.infer<typeof modelChatIntentSchema> | null {
    try {
        const parsed = modelChatIntentSchema.safeParse(JSON.parse(text));
        if (!parsed.success || /\b(?:public|private)[ -]sector\b/i.test(`${parsed.data.role} ${parsed.data.where}`))
            return null;
        return { ...parsed.data, where: normalizeChatWhere(parsed.data.where) };
    } catch {
        return null;
    }
}
