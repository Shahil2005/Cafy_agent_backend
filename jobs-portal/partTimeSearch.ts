/**
 * Part-time role search: turns the "Job role" box into word-start regex
 * filters with light stemming and a small UK part-time synonym list, then
 * ranks matches (exact phrase in title first, department-only matches last).
 *
 * Patterns only ever contain [a-z0-9 ] so the generated PostgREST filter
 * values cannot inject operators.
 */
import { JOBS_SEARCH_QUERY_MAX_LENGTH } from './constants';

const MAX_TERMS = 6;
const MAX_PATTERNS_PER_TERM = 18;
/** Words this short must match a whole word ("bar" ≠ "barista", "kp" ≠ "kpmg"). */
const WHOLE_WORD_MAX_LENGTH = 3;

const STOPWORDS = new Set([
    'a', 'an', 'and', 'or', 'the', 'of', 'in', 'at', 'for', 'to', 'with', 'on', 'near', 'me',
    'job', 'jobs', 'role', 'roles', 'vacancy', 'vacancies', 'position', 'positions', 'hiring',
    'part', 'time', 'parttime', 'pt', 'uk',
]);

/**
 * Each group lists equivalent role words or phrases. A query word or phrase that
 * matches any member also searches every other member of its group.
 */
const SYNONYM_GROUPS: readonly string[][] = [
    ['cleaner', 'cleaning', 'housekeeper', 'housekeeping', 'domestic assistant'],
    ['waiter', 'waitress', 'waiting staff', 'server', 'front of house', 'foh'],
    ['bartender', 'barman', 'barmaid', 'bar', 'bar staff', 'bar team', 'bar person', 'mixologist'],
    ['barista'],
    ['chef', 'cook', 'commis'],
    ['kitchen porter', 'kp', 'pot wash', 'kitchen assistant'],
    ['cashier', 'checkout', 'till operator'],
    ['carer', 'care assistant', 'care worker', 'caregiver', 'home care', 'support worker'],
    ['healthcare assistant', 'health care assistant', 'hca'],
    ['nanny', 'childminder', 'babysitter', 'au pair', 'childcare'],
    ['receptionist', 'reception', 'front desk'],
    ['security', 'security officer', 'guard', 'door supervisor'],
    ['driver', 'courier', 'delivery driver'],
    ['warehouse', 'warehouse operative', 'picker', 'packer'],
    ['retail', 'shop', 'store'],
    ['sales', 'retail'],
    ['assistant', 'associate', 'advisor', 'adviser', 'colleague', 'team member', 'crew member', 'staff', 'team', 'crew', 'worker', 'operative'],
    ['admin', 'administrator', 'administrative', 'clerical', 'office assistant'],
    ['host', 'hostess', 'greeter'],
    ['lifeguard', 'pool attendant'],
    ['merchandiser', 'visual merchandiser'],
    ['stock', 'replenishment', 'shelf'],
    ['hairdresser', 'hair stylist', 'barber'],
    ['christmas', 'seasonal', 'temporary'],
    ['weekend', 'saturday', 'sunday'],
];

export interface PartTimeRoleTerm {
    /** What the user typed for this term (one word or a known phrase). */
    label: string;
    /** Forms of the user's own word (plural, -er/-ing). Used for ranking. */
    ownPatterns: string[];
    /** ownPatterns plus synonyms. Used for filtering. */
    patterns: string[];
}

export interface PartTimeRoleQuery {
    terms: PartTimeRoleTerm[];
    /** Non-stopword words joined by spaces — the exact-phrase ranking target. */
    phrase: string;
}

function normalizeText(raw: string): string {
    return raw
        .slice(0, JOBS_SEARCH_QUERY_MAX_LENGTH)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function singular(word: string): string {
    if (word.length <= 3) return word;
    if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
    if (/(ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
    if (/[^su]s$/.test(word) && !word.endsWith('is')) return word.slice(0, -1);
    return word;
}

/** Plural, -er ↔ -ing and silent-e forms ("cleaner" → cleaning, "baking" → bake). */
function wordForms(word: string): string[] {
    const forms = new Set<string>([word]);
    const one = singular(word);
    forms.add(one);

    if (one.endsWith('er') && one.length >= 5) {
        const root = one.slice(0, -2);
        forms.add(`${root}ing`);
        if (!root.endsWith('e')) forms.add(`${root}e`);
    }
    if (one.endsWith('ing') && one.length >= 6) {
        const root = one.slice(0, -3);
        forms.add(`${root}er`);
        forms.add(`${root}e`);
        if (root.length >= 4) forms.add(root);
        if (/([b-df-hj-np-tv-z])\1$/.test(root)) forms.add(root.slice(0, -1));
    }
    return [...forms].filter((form) => form.length >= 2);
}

const PHRASE_GROUPS = new Map<string, number[]>();
const WORD_GROUPS = new Map<string, number[]>();
SYNONYM_GROUPS.forEach((group, index) => {
    for (const member of group) {
        const target = member.includes(' ') ? PHRASE_GROUPS : WORD_GROUPS;
        const list = target.get(member) ?? [];
        list.push(index);
        target.set(member, list);
    }
});

function groupMembers(indexes: number[] | undefined): string[] {
    if (!indexes) return [];
    return indexes.flatMap((index) => SYNONYM_GROUPS[index] ?? []);
}

function uniqueCapped(values: string[]): string[] {
    return [...new Set(values)].slice(0, MAX_PATTERNS_PER_TERM);
}

/** Parse the role box. Returns no terms when only stopwords were typed. */
export function parsePartTimeRoleQuery(raw: string | undefined): PartTimeRoleQuery {
    const words = normalizeText(raw || '')
        .split(' ')
        .filter((word) => word.length >= 2 && !STOPWORDS.has(word));

    const terms: PartTimeRoleTerm[] = [];
    let i = 0;
    while (i < words.length && terms.length < MAX_TERMS) {
        let consumed = 0;
        for (const size of [3, 2]) {
            if (i + size > words.length) continue;
            const phrase = words.slice(i, i + size).join(' ');
            const phraseSingular = words
                .slice(i, i + size)
                .map((word, idx) => (idx === size - 1 ? singular(word) : word))
                .join(' ');
            const groups = PHRASE_GROUPS.get(phrase) ?? PHRASE_GROUPS.get(phraseSingular);
            if (groups) {
                const own = [phrase, phraseSingular];
                terms.push({
                    label: phrase,
                    ownPatterns: uniqueCapped(own),
                    patterns: uniqueCapped([...own, ...groupMembers(groups)]),
                });
                consumed = size;
                break;
            }
        }
        if (consumed > 0) {
            i += consumed;
            continue;
        }

        const word = words[i]!;
        const forms = wordForms(word);
        const synonyms = forms.flatMap((form) => groupMembers(WORD_GROUPS.get(form)));
        terms.push({
            label: word,
            ownPatterns: uniqueCapped(forms),
            patterns: uniqueCapped([...forms, ...synonyms]),
        });
        i += 1;
    }

    return { terms, phrase: words.join(' ') };
}

function patternBody(pattern: string): string {
    return pattern.split(' ').filter(Boolean).join('[^a-z0-9]+');
}

const SAFE_PATTERN = /^[a-z0-9 ]+$/;

/**
 * Regex source matching the pattern at the start of a word (short patterns:
 * the whole word). Works in Postgres (~*) and JS.
 */
export function wordStartRegex(pattern: string, wholeWord = false): string {
    const tail = wholeWord || pattern.length <= WHOLE_WORD_MAX_LENGTH ? '([^a-z0-9]|$)' : '';
    return `(^|[^a-z0-9])${patternBody(pattern)}${tail}`;
}

/** Synonyms match whole words only (plural allowed): "commis" ≠ "Commissioning". */
function synonymRegex(pattern: string): string {
    return `(^|[^a-z0-9])${patternBody(pattern)}(s|es)?([^a-z0-9]|$)`;
}

function synonymsOf(term: PartTimeRoleTerm): string[] {
    const own = new Set(term.ownPatterns);
    return term.patterns.filter((pattern) => !own.has(pattern));
}

/**
 * One PostgREST `or` filter per term — chain them so every term must match.
 * Title: the user's word forms at a word start, synonyms as whole words. Department holds broad categories
 * ("NHS", "Retail & Hospitality"), so it only matches when the user's own word
 * is the whole department ("nhs" → NHS, "cleaning" → Cleaning).
 */
export function partTimeRoleTermFilter(term: PartTimeRoleTerm): string {
    const clauses: string[] = [];
    for (const pattern of term.ownPatterns) {
        if (!SAFE_PATTERN.test(pattern)) continue;
        clauses.push(`title.imatch."${wordStartRegex(pattern)}"`);
    }
    for (const pattern of synonymsOf(term)) {
        if (!SAFE_PATTERN.test(pattern)) continue;
        clauses.push(`title.imatch."${synonymRegex(pattern)}"`);
    }
    for (const pattern of term.ownPatterns) {
        if (!SAFE_PATTERN.test(pattern)) continue;
        clauses.push(`department.imatch."^${patternBody(pattern)}(s|es)?$"`);
    }
    return clauses.join(',');
}

export function partTimeRoleFingerprint(query: PartTimeRoleQuery): string {
    return query.terms.map((term) => term.patterns.join('+')).join('&');
}

function compile(patterns: string[], wholeWord: boolean): RegExp[] {
    return patterns.map(
        (pattern) =>
            new RegExp(wordStartRegex(pattern, wholeWord), 'i'),
    );
}

function everyTermHits(termRegexes: RegExp[][], title: string): boolean {
    return termRegexes.every((regexes) => regexes.some((re) => re.test(title)));
}

/**
 * Relevance tier for a matched row (lower is better):
 * 0 exact phrase in title, 1 every term in title as a whole word,
 * 2 every term in title as a word start ("stock" → "Stockroom"),
 * 3 every term in title via synonyms, 4 the rest (department-only matches).
 */
export function createPartTimeRoleRanker(query: PartTimeRoleQuery): (title: string) => number {
    const phraseRegex =
        query.phrase && query.terms.length > 1
            ? new RegExp(wordStartRegex(query.phrase), 'i')
            : null;
    const ownWhole = query.terms.map((term) => compile(term.ownPatterns, true));
    const ownStart = query.terms.map((term) => compile(term.ownPatterns, false));
    const all = query.terms.map((term) => [
        ...ownStart[query.terms.indexOf(term)]!,
        ...synonymsOf(term).map((pattern) => new RegExp(synonymRegex(pattern), 'i')),
    ]);

    return (rawTitle: string) => {
        const title = rawTitle.toLowerCase();
        if (phraseRegex?.test(title)) return 0;
        if (everyTermHits(ownWhole, title)) return 1;
        if (everyTermHits(ownStart, title)) return 2;
        if (everyTermHits(all, title)) return 3;
        return 4;
    };
}
