import type { AutofillProfile, ScrapedFieldInput } from '../schemas/autofill';

/*
 * How sensitive questions are handled:
 * - 'never':    the candidate's own legal act or secret (consents/attestations, passwords, ID numbers,
 *               criminal record), and gender. Never filled, whatever the resume says.
 * - 'eeo':      equal-opportunities / demographic questions. A resume never answers these, so the
 *               "Prefer not to say" option is chosen when the form offers one.
 * - 'evidence': eligibility & logistics (visa, salary, notice period, start date, ...). Filled only when
 *               the resume states the answer explicitly — the model must quote it, and the quote is
 *               verified against the resume text server-side.
 */
export type SensitiveKind = 'never' | 'eeo' | 'evidence';

export type SensitiveMatch = { kind: SensitiveKind; reason: string };

// Checked in order; first match wins. Tested against the question text only (label, description,
// name, placeholder) — option lists contain words like "Careers page" that would false-positive.
const SENSITIVE_PATTERNS: Array<{ kind: SensitiveKind; reason: string; pattern: RegExp }> = [
    { kind: 'never', reason: 'password', pattern: /pass\s*word|passcode/i },
    // Someone else's details: the resume's email / phone would pass every check yet be wrong here
    {
        kind: 'never',
        reason: 'other_person',
        pattern: /\breferee'?s?\b|\breference'?s?\s+(name|e-?mail|phone|mobile|contact|number|title|company|relationship)|emergency\s+contact|next\s+of\s+kin|\bguardian|\bspouse|\bparent'?s?\s+(name|e-?mail|phone)|(manager|supervisor)'?s?\s+(name|e-?mail|phone|contact|number)|\bwho\s+referred|\brelatives?\b|family\s+members?|related\s+to\s+(anyone|someone|any\s+(current\s+)?employee)/i,
    },
    {
        kind: 'never',
        reason: 'national_id',
        pattern: /\bssn\b|social\s+security|national\s+insurance|\bni\s+number|\bnino?\b|passport\s*(no|number)|tax\s*(id|number)|aadhaa?r|\bpan\s*(card|number)|driv(er'?s|ing)\s+licen[cs]e\s+(no|number)/i,
    },
    { kind: 'never', reason: 'criminal_record', pattern: /convict|criminal|offen[cs]e|background\s+check|\bdbs\b/i },

    // Gender is left blank for the candidate to answer themselves - not even "Prefer not to say" is chosen
    { kind: 'never', reason: 'eeo', pattern: /\bgender\b|\bpronouns?\b|\bsex\b|transgender/i },
    { kind: 'eeo', reason: 'eeo', pattern: /ethnic|\brace\b|racial|hispanic|latin[oa]/i },
    { kind: 'eeo', reason: 'eeo', pattern: /disabilit|impairment|neurodiver/i },
    { kind: 'eeo', reason: 'eeo', pattern: /veteran|armed\s+forces|military\s+(service|status)/i },
    { kind: 'eeo', reason: 'eeo', pattern: /sexual\s+orientation|lgbt|religio|belief|marital|caring\s+responsib|socio-?economic/i },
    {
        kind: 'eeo',
        reason: 'eeo',
        pattern: /communit(y|ies)\b.{0,40}\b(belong|identify|part\s+of)|identify\s+(as|with)\b|\bimmigrant|\brefugee|first[-\s]generation|underrepresented|demographic|\bcaste\b|\btribe\b/i,
    },

    // Sponsorship first: resumes do state "will require sponsorship", so it can be answered from a quote.
    { kind: 'evidence', reason: 'visa', pattern: /sponsor/i },
    // Work authorisation depends on the job's country as much as the candidate's status — the resume
    // alone can't answer it (a UK visa says nothing about the right to work in Canada).
    {
        kind: 'never',
        reason: 'work_authorization',
        pattern: /right\s+to\s+work|work\s*(authori[sz]ation|permit|visa)|(authori[sz]ed|eligible|legally\s+(able|permitted))\b.{0,40}\bwork|immigration|visa\s*status|citizenship|nationality/i,
    },
    { kind: 'evidence', reason: 'salary', pattern: /salary|compensation|remuneration|\bctc\b|pay\s*(expectation|range|rate)|expected\s*(pay|rate)|(day|hourly)\s*rate/i },
    { kind: 'evidence', reason: 'notice_period', pattern: /notice\s*period/i },
    { kind: 'evidence', reason: 'relocation', pattern: /relocat|willing\s+to\s+(travel|commute)/i },
    { kind: 'evidence', reason: 'date_of_birth', pattern: /date\s+of\s+birth|birth\s*date|\bdob\b|\bage\b/i },
    // Not in any resume: how the candidate found the job is theirs to say.
    {
        kind: 'never',
        reason: 'referral',
        pattern: /how\s+did\s+you\s+(initially\s+)?(hear|find|learn|come)|(hear|heard)\s+about\s+(this|the|us)|who\s+referred|\breferr(al|ed|er)\b|recruiter'?s?\s+name/i,
    },
    {
        kind: 'evidence',
        reason: 'legal',
        pattern: /non-?compete|non-?solicit|restrictive\s+covenant|confidentiality\s+agreement|conflict\s+of\s+interest|previously\s+(been\s+)?employed\s+(by|at|with)|related\s+to\s+(any|an)\s+(current\s+)?employee|security\s+clearance/i,
    },
    // "If you chose X, please specify" depends on another answer the resume can't give.
    { kind: 'evidence', reason: 'follow_up', pattern: /^\s*if\s+(you\s+)?(chose|selected|picked|answered|clicked)\b/i },
];

/*
 * Consents, acknowledgements and attestations. Neutral titles ("Acknowledge/Confirm", "Interview Recording
 * Policy") are common, so this is also checked against the description and the option labels.
 * "Confirm email" / "Confirm password" style fields are data entry, not consent.
 */
const CONSENT =
    /acknowledg|\bconsent|attest|\b(can|could|do|will)\s+you\s+(please\s+)?confirm\b|\bconfirm\s+that\b|\b(true|accurate|complete)\s+(and|&)\s+(accurate|complete|correct)\b|\bcertif(y|ies)\b|\bi\s+(hereby\s+)?(agree|confirm|accept|understand|declare)\b|\bagree\s+to\b|terms\s+(and|&)\s+conditions|privacy\s+(policy|notice)|\bpolicy\b|\brecording\b|\bgdpr\b|signature|\be-?sign(ed|ature)?\b/i;
/** Consent questions offer a handful of choices; long lists (universities with "Design" in the name) are data. */
const MAX_CONSENT_OPTIONS = 10;
const CONSENT_CONTROLS = new Set(['checkbox', 'checkbox-group', 'radio', 'select', 'select-multiple', 'button-group', 'switch']);
const CONFIRM_ONLY = /^\s*(i\s+)?confirm\s*\.?\s*$/i;
const DATA_CONFIRMATION = /confirm\s+(your\s+)?(e-?mail|password|phone|mobile)/i;

const INTENT_OPTION = /relocat|\bwilling\b|planning\s+(on|to)|\bintend/i;

/**
 * Per-reason extra check on the quoted evidence: for intent questions, a quote that only proves where the
 * candidate lives ("Manchester, UK") must not justify "not willing to relocate".
 */
const EVIDENCE_TOPIC: Record<string, RegExp> = {
    relocation: /relocat|willing|open\s+to/i,
    notice_period: /notice|available|availability|immediate/i,
    start_date: /start|available|availability|notice|immediate/i,
    salary: /salary|compensation|ctc|package|expect|£|\$|€|₹|\bk\b|\d/i,
    visa: /visa|sponsor|citizen|permanent\s+resid|right\s+to\s+work|work\s+permit|authori[sz]|eligib|nationality|passport|green\s*card|\bpr\b/i,
};

export function evidenceMatchesTopic(reason: string, evidence: string | null): boolean {
    const topic = EVIDENCE_TOPIC[reason];
    return !topic || (!!evidence && topic.test(evidence));
}

/*
 * A block about someone else: every field under it is theirs, even with a bland label ("Telephone no." under
 * "Referee 1"). Not "Job reference" / "Reference number" headings, nor "Preferences".
 */
const OTHER_PERSON_SECTION =
    /\breferees?\b|\breferences\b|^\s*references?\s*(\d+|details|information)?\s*:?\s*$|\b(character|professional|employment|personal|work)\s+references?\b|emergency\s+contact|next\s+of\s+kin/i;

// An entire "Equal opportunities" block is demographic, even when a question label is bland ("Please select").
const EEO_SECTION = /equal\s+(opportunit|employment)|diversity|self[-\s]?identif|\beeo\b|voluntary\s+disclosure/i;

// "Start date" is availability unless it's about education / work history.
const AVAILABILITY_START = /(earliest|available|availability).{0,30}(start|join)|when\s+can\s+you\s+(start|join)|\bstart\s*date\b/i;
const EXPLICIT_AVAILABILITY = /earliest|available|availability|when\s+can\s+you|\bjoin\b|notice/i;
/** Fields that make a form a work / education history form. */
export const HISTORY_FIELD =
    /company|employer|organi[sz]ation|school|universit|college|institution|job\s+title|position\s+title|work\s+history|employment\s+history|^\s*education\s*$/i;
const HISTORY_CONTEXT =/education|experience|employment|work\s+history|qualification|school|universit|degree|course/i;

function questionText(field: ScrapedFieldInput): string {
    return [field.label, field.description, field.name, field.placeholder].filter(Boolean).join(' | ');
}

/**
 * `formHasHistory`: the form also asks for companies / schools, so a bare "Start date" belongs to a work or
 * education entry rather than asking for availability (Breezy's Work History blocks).
 */
export function detectSensitiveField(field: ScrapedFieldInput, formHasHistory = false): SensitiveMatch | null {
    if (field.type === 'password') return { kind: 'never', reason: 'password' };

    const text = questionText(field);
    const optionText = field.options.map((o) => o.label || o.value).join(' | ');
    const consentOptions = field.options.length <= MAX_CONSENT_OPTIONS && CONSENT.test(optionText);
    // Consent is given by ticking/choosing. For typed fields only the label counts, so an Email box whose
    // description mentions "our privacy policy" is still filled.
    const consentText = CONSENT_CONTROLS.has(field.type) ? text : (field.label ?? '');
    if (!DATA_CONFIRMATION.test(text) && (CONSENT.test(consentText) || consentOptions || CONFIRM_ONLY.test(field.label ?? ''))) {
        return { kind: 'never', reason: 'consent' };
    }

    if (field.section && OTHER_PERSON_SECTION.test(field.section)) return { kind: 'never', reason: 'other_person' };

    for (const { kind, reason, pattern } of SENSITIVE_PATTERNS) {
        if (pattern.test(text)) return { kind, reason };
    }

    // A gender question whose title wasn't read ("Male / Female / Non-binary" radios): leave it for the candidate
    if (field.options.length <= MAX_CONSENT_OPTIONS && GENDER_OPTION_MALE.test(optionText) && GENDER_OPTION_FEMALE.test(optionText)) {
        return { kind: 'never', reason: 'eeo' };
    }

    // "Please confirm you're based in BC" with options like "No, but I'm planning on relocating": the options
    // assert intent, so treat it like a relocation question even though the title doesn't say so.
    if (field.options.length <= MAX_CONSENT_OPTIONS && INTENT_OPTION.test(optionText)) return { kind: 'evidence', reason: 'relocation' };

    // Unclassified question offering "Prefer not to answer": a demographic question in practice
    if (field.options.length <= MAX_CONSENT_OPTIONS && field.options.some((o) => PREFER_NOT_OPTION.test(o.label || o.value))) {
        return { kind: 'eeo', reason: 'eeo' };
    }

    const plainEntryDate = formHasHistory && !EXPLICIT_AVAILABILITY.test(text);
    if (AVAILABILITY_START.test(text) && !HISTORY_CONTEXT.test(text) && !plainEntryDate) return { kind: 'evidence', reason: 'start_date' };
    if (EEO_SECTION.test(text)) return { kind: 'eeo', reason: 'eeo' };

    return null;
}

const GENDER_OPTION_MALE = /\b(male|man)\b/i;
const GENDER_OPTION_FEMALE = /\b(female|woman)\b/i;

export const PREFER_NOT_OPTION = /prefer\s+not|don'?t\s+wish|do\s+not\s+wish|decline|not\s+to\s+(answer|say|disclose)|rather\s+not/i;

/* ---------------------------------------------------------------------------
 * Hallucination guards: contact details and quoted evidence must literally
 * appear in the resume.
 * ------------------------------------------------------------------------- */

export function squash(text: string): string {
    return text.toLowerCase().replace(/[\s()\-.+,'"’:;/_]/g, '');
}

function normalizeUrl(url: string): string {
    return url
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[/?#]+$/, '')
        .replace(/\s+/g, '');
}

export function resumeContainsEmail(resumeText: string, email: string): boolean {
    return resumeText.toLowerCase().includes(email.trim().toLowerCase());
}

/** Full number, or its last 9 digits (country-code / trunk-prefix differences). */
export function resumeContainsPhone(resumeText: string, phone: string): boolean {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) return false;
    const resumeDigits = resumeText.replace(/[^\d\n]/g, '');
    const tail = digits.slice(-9);
    return resumeDigits.includes(digits) || (tail.length === 9 && resumeDigits.includes(tail));
}

export function resumeContainsUrl(resumeText: string, url: string): boolean {
    const normalized = normalizeUrl(url);
    return normalized.length >= 4 && resumeText.toLowerCase().replace(/\s+/g, '').includes(normalized);
}

/** The model's quoted evidence must be a real excerpt of the resume (punctuation/spacing-insensitive). */
export function resumeContainsEvidence(resumeText: string, evidence: string | null): boolean {
    if (!evidence) return false;
    const quote = squash(evidence);
    return quote.length >= 4 && squash(resumeText).includes(quote);
}

/** Free app hosting: a URL here is usually one project's demo, not the candidate's own site. */
const APP_HOST = /(^|\.)(hf\.space|huggingface\.co|vercel\.app|netlify\.app|streamlit\.app|onrender\.com|herokuapp\.com|github\.io|pages\.dev|web\.app|firebaseapp\.com|replit\.app|repl\.co|glitch\.me|fly\.dev|railway\.app|surge\.sh)$/i;
const PORTFOLIO_WORD = /portfolio|resume|\bcv\b|about-?me/i;

/**
 * A portfolio on free app hosting must look personal: the candidate's name or "portfolio" in the address
 * ("jane-doe.vercel.app", "jdoe.github.io"). "inbox-os.hf.space/demo" is a project demo, not a portfolio.
 * Own domains, Behance, Dribbble etc. are taken as given.
 */
export function looksLikePersonalSite(url: string, profile: Pick<AutofillProfile, 'firstName' | 'lastName'>): boolean {
    let host: string;
    let path: string;
    try {
        const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
        host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        path = parsed.pathname.replace(/\/+$/, '');
    } catch {
        return false;
    }
    if (!APP_HOST.test(host)) return true;
    const site = host.replace(APP_HOST, '');
    if (PORTFOLIO_WORD.test(`${site} ${path}`)) return true;
    // A page under the site ("/demo", "/inbox-os") is a project; github.io root is the user's own page
    if (path !== '') return false;
    if (/github\.io$/.test(host)) return true;
    // Short names ("Dev", "Al") turn up inside project names, so they only count together with the surname
    const letters = site.replace(/[^a-z]/g, '');
    const [first, last] = [profile.firstName, profile.lastName].map((n) => (n ?? '').toLowerCase().replace(/[^a-z]/g, ''));
    return [first, last, first && last ? first + last : ''].some((n) => n.length >= 4 && letters.includes(n));
}

export function verifyProfileAgainstResume(profile: AutofillProfile, resumeText: string): AutofillProfile {
    const keepUrl = (url: string | null): string | null => (url && resumeContainsUrl(resumeText, url) ? url : null);

    const portfolio = keepUrl(profile.links.portfolio);
    const personal = portfolio && looksLikePersonalSite(portfolio, profile) ? portfolio : null;
    const other = profile.links.other.filter((u) => keepUrl(u) !== null);
    return {
        ...profile,
        email: profile.email && resumeContainsEmail(resumeText, profile.email) ? profile.email : null,
        phone: profile.phone && resumeContainsPhone(resumeText, profile.phone) ? profile.phone : null,
        links: {
            linkedin: keepUrl(profile.links.linkedin),
            github: keepUrl(profile.links.github),
            portfolio: personal,
            // A project demo the model took for a portfolio is still a real link of the candidate's
            other: portfolio && !personal && !other.includes(portfolio) ? [...other, portfolio] : other,
        },
    };
}
