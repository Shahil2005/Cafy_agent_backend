/**
 * Code-decided tool calls. When the question is clearly about official rules or the user's own CV,
 * the matching tool runs BEFORE the model, so answers come from GOV.UK passages or CV data rather
 * than model memory, and the model's separate "which tool?" step is usually skipped.
 */
import { isAboutOwnCv, isCvSummaryRequest, isJobsForMe } from './cvIntent';

const GOV_UK_TOPICS = new RegExp(
    [
        // Visas and immigration rules
        'visa', 'dependants?', 'settlement', 'indefinite leave', '\\bilr\\b',
        'certificate of sponsorship', 'sponsor licen[cs]e', 'english (?:language )?requirement', 'immigration health surcharge', '\\bihs\\b', 'biometric', '\\bbrp\\b', 'e-?visa',
        'right to work', 'share code', 'new entrant', 'visa fees?', 'how much (?:are|is) (?:the |it )?(?:fees?|cost)', 'application fees?', 'overstay',
        // Work rights
        'minimum wage', 'living wage', 'holidays? (?:pay|entitlement|allowance)', 'holiday am i', 'how much holiday', 'annual leave', 'bank holidays?', 'sick pay', '\\bssp\\b', 'maternity', 'paternity', 'notice period', 'redundancy', 'made redundant', 'unfair(?:ly)? dismiss', 'dismissed',
        'discriminat', 'not paying', "isn'?t paying", 'unpaid (?:wages|pay)', 'fired', 'sacked', '(?:pounds?|£\\s?\\d+(?:\\.\\d+)?) (?:an|per) hour', 'working hours', 'zero[- ]hours', 'employment contract', 'payslip', 'grievance', 'whistleblow', 'trade union',
        // Starting work, tax and money
        'national insurance', '\\bni number\\b', 'tax code', '\\bp45\\b', '\\bp60\\b', '\\bpaye\\b', 'income tax', 'student loan', 'apprentice',
    ].join('|'),
    'i',
);

/**
 * Words that mean a GOV.UK topic only in a work or immigration setting: "switching to Python",
 * "settle an argument", "unfair exam", "my wife's birthday", "cos" (because) are everyday questions.
 */
const GOV_UK_AMBIGUOUS =
    /\bswitch(?:ing)? (?:to|from)\b|\bmy partner\b|\bbring my (?:family|children|spouse)\b|\bsettle\b|\bcos\b|\b(?:wife|husband|spouse)\b|\bunfair\b|\bpregnan|\bredundant\b|\bdismiss/i;
const WORK_OR_IMMIGRATION =
    /\b(?:visas?|immigra\w*|uk|britain|home office|ukvi|sponsor\w*|dependants?|skilled worker|graduate route|student route|right to work|work(?:ing|s|ed)?|jobs?|employ\w*|boss|manager|contract|pay|paid|wages?|salary|maternity|leave|tribunal|hr|acas)\b/i;

export function needsGovUkGuidance(message: string): boolean {
    return GOV_UK_TOPICS.test(message) || (GOV_UK_AMBIGUOUS.test(message) && WORK_OR_IMMIGRATION.test(message));
}

export interface ForcedCall {
    name: string;
    args: Record<string, unknown>;
}

/** "How many years of experience do I have?" (about the user's own CV, not a job's requirement). */
const EXPERIENCE_YEARS = /\b(?:how (?:many|much)|number of|total)\b[^?.!]{0,40}\b(?:years?|experience)\b|\byears? of (?:work )?experience\b/i;
const SOC = /\bsoc\b|\boccupation code\b/i;
const SPONSORS_IN_PLACE = /\b(?:companies|employers|businesses|firms|organisations|who|which)\b[^?.!]{0,30}\b(?:in|near)\s+([A-Z][a-zA-Z' -]{2,30}?)\s+(?:sponsor|that sponsor|can sponsor|hold)|\bsponsors?\s+in\s+([A-Z][a-zA-Z' -]{2,30}?)\s*[?.!]?\s*$/;
const SOC_PAY_FOR_ROLE = /\b(?:new entrant|going rate|salary threshold|visa salary|threshold)\b[^?.!]{0,30}\b(?:for|of)\s+(?:a|an)\s+([a-z][a-z -]{2,40}?)\s*[?.!]?\s*$/i;

/** A job question does not need the whole CV profile: the job tools read the CV themselves. */
const MENTIONS_JOBS = /\b(?:jobs?|roles?|vacanc(?:y|ies)|internships?|positions?)\b/i;

/** SOC codes only come up when the talk is about them or visas: a job search should show jobs, not codes. */
const SOC_TOPIC = /\bsoc\b|occupation code|\bvisas?\b|sponsor|skilled worker|going rate|new entrant|salary threshold|immigration|eligible list|\b(?:come|coming|move|moving|relocat\w*|migrat\w*|emigrat\w*)\b[^.?!]{0,40}\b(?:uk|u\.k\.|britain|england|scotland|wales|northern ireland)\b/i;

export function asksAboutSoc(message: string, recentTurns: string[] = []): boolean {
    return [message, ...recentTurns].some((text) => SOC_TOPIC.test(text));
}

/** With a CV chosen, any first-person question gets the full CV profile, so answers are complete. */
const FIRST_PERSON = /\b(?:i|me|my|mine|myself|i'm|i've|i'd)\b/i;

const SPONSOR_QUESTION = /\b(?:sponsor(?:s|ship|ing)?|licen[cs]ed|licen[cs]e holder|on the (?:sponsor )?register)\b/i;
/** "Does Tesco sponsor…", "Is Deloitte a licensed sponsor?", "Will Google sponsor me?" */
const NAME_BEFORE_VERB =
    /^(?:does|do|will|would|can|could|is|are|has|have)\s+(?:the\s+)?(.{2,60}?)\s+(?:sponsor|hold|have|has|a (?:licensed |registered |approved |visa )?sponsor|an? (?:approved|registered|licensed)|licensed|on the|still|offer|give|provide|currently|actually|really|ever)\b/i;
const NAME_CALLED = /\b(?:called|named)\s+(.{2,60}?)(?:\s+in\s+|\s*[?.!]?$)/i;
const NOT_A_NAME = /^(?:i|you|we|they|it|this|that|my|your|our|their|an?|any|all|most|some|small|big|uk|british|companies|employers|businesses|universities)\b|\bvisas?\b/i;

/** The company a sponsor question is about, when the wording makes it certain. */
export function sponsorNameIn(message: string): string | null {
    if (!SPONSOR_QUESTION.test(message)) return null;
    const value = message.trim();
    const name = (NAME_BEFORE_VERB.exec(value)?.[1] ?? NAME_CALLED.exec(value)?.[1])?.trim();
    return name && !NOT_A_NAME.test(name) ? name : null;
}

/**
 * Tool calls code is sure about for this message, run before the model's first step.
 * The model still sees every tool and decides the answer: this only hands it the data early,
 * so a wrong guess costs one unused lookup, never a wrong answer.
 */
export function forcedToolCalls(message: string, available: Set<string>, ctx: { hasCv?: boolean; pastedAdvert?: boolean } = {}): ForcedCall[] {
    const calls: ForcedCall[] = [];
    const can = (name: string) => available.has(name);
    if (can('gov_uk_guidance') && needsGovUkGuidance(message)) calls.push({ name: 'gov_uk_guidance', args: { question: message.slice(0, 300) } });
    const inPlace = SPONSORS_IN_PLACE.exec(message);
    const place = (inPlace?.[1] ?? inPlace?.[2])?.trim();
    if (can('find_sponsors') && place) calls.push({ name: 'find_sponsors', args: { city: place } });
    // "Going rate for SOC 2134": the code is known, so go straight to its full figures.
    const payForCode = /\b(?:going rate|salary|threshold|new entrant|pay)\b/i.test(message) ? /\bsoc\s*(?:code\s*)?(\d{4})\b/i.exec(message)?.[1] : undefined;
    if (can('visa_salary_rules') && payForCode) calls.push({ name: 'visa_salary_rules', args: { socCode: payForCode } });
    const onList = /\b(?:is|are)\s+(?:an?\s+)?([a-z][a-z -]{2,40}?)\s+on the (?:eligible|skilled)/i.exec(message)?.[1];
    const socRole = SOC_PAY_FOR_ROLE.exec(message)?.[1] ?? onList;
    if (can('soc_lookup') && socRole) calls.push({ name: 'soc_lookup', args: { query: socRole } });
    const sponsor = sponsorNameIn(message);
    if (can('find_sponsors') && sponsor) calls.push({ name: 'find_sponsors', args: { name: sponsor } });
    if (ctx.hasCv && can('get_cv_profile') && !MENTIONS_JOBS.test(message) && (isAboutOwnCv(message) || isCvSummaryRequest(message) || FIRST_PERSON.test(message))) calls.push({ name: 'get_cv_profile', args: {} });
    if (ctx.hasCv && isAboutOwnCv(message)) {
        if (can('get_experience_years') && EXPERIENCE_YEARS.test(message)) calls.push({ name: 'get_experience_years', args: {} });
        if (can('soc_lookup') && SOC.test(message)) calls.push({ name: 'soc_lookup', args: {} });
    }
    // Plain "jobs for my CV": the search needs nothing from the model, so it starts at once and the model only writes the answer.
    if (ctx.hasCv && can('search_jobs') && isPlainJobsForMe(message)) calls.push({ name: 'search_jobs', args: {} });
    // A pasted advert with only "jobs like this": the advert is the whole query, so the search starts at once.
    // Any other detail (a place, a type, "does it fit me") goes to the model, which reads the words.
    else if (ctx.pastedAdvert && can('search_jobs') && isPlainJobsLikeAdvert(message)) calls.push({ name: 'search_jobs', args: {} });
    // "How can I earn more / get better-paid jobs": real pay and better-paid adverts first, so the answer is grounded.
    if (ctx.hasCv && can('higher_pay') && EARN_MORE.test(message) && !/\bhow much\b/i.test(message)) calls.push({ name: 'higher_pay', args: {} });
    return calls;
}

/** Wanting more pay for themselves, not asking what a role pays. */
const EARN_MORE =
    /\b(?:earn|make)\s+more\b|\b(?:more|higher|better)[- ](?:earning|paying|paid|salar(?:y|ies)|income|money)\b|\b(?:higher|bigger|better|increase (?:my|in)|raise (?:my)?)\s*(?:salary|pay|income)\b|\b(?:salary|pay)\s+(?:increase|rise|raise|growth)\b/i;

/** Every word a plain request for jobs from the CV may use. Any other word (a role, place, number, "best", "more") needs the model. */
const PLAIN_JOB_REQUEST_WORDS = new Set(
    'please pls can could would you will find show give get me some a any good suitable relevant jobs job roles role vacancies vacancy openings opening positions position for that which match matches matching suit suits suiting suitable fit fits fitting based on from with my cv c v resume résumé profile skills skill experience background hi hey hello cafy i want need am looking look'.split(' '),
);

const ADVERT_REFERENCE_WORDS = new Set('similar like this that these one ones other others same kind type sort of as to the jd advert ad description posting listing below above here just more'.split(' '));
const ASKS_FOR_MANY = /\b(?:jobs|roles|positions|vacancies|openings|similar|others)\b/i;

/** "Find jobs like this", "jobs similar to this JD that suit my CV": a search for the pasted advert and nothing else. */
export function isPlainJobsLikeAdvert(ask: string): boolean {
    if (!ASKS_FOR_MANY.test(ask) || ask.length > 120) return false;
    const words = ask.toLowerCase().replace(/[?.!,:;]/g, ' ').split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every((word) => PLAIN_JOB_REQUEST_WORDS.has(word) || ADVERT_REFERENCE_WORDS.has(word));
}

export function isPlainJobsForMe(message: string): boolean {
    if (!isJobsForMe(message) || message.length > 100) return false;
    const words = message.toLowerCase().replace(/[?.!,]/g, ' ').split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every((word) => PLAIN_JOB_REQUEST_WORDS.has(word));
}
