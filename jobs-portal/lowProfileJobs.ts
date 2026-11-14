/**
 * Roles we do not show in the jobs portal. Rows stay in the database, and
 * catalog / company counts are not reduced.
 */

function normalize(value: string): string {
    return value
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Title phrases that are low-profile on their own. */
const TITLE_PHRASES = [
    // ATS placeholder / test postings (e.g. "DO NOT APPLY- TEST 3")
    'do not apply',
    'bar and waiting staff',
    'waiting staff',
    'bar staff',
    'bartender',
    'barista',
    'waiter',
    'waitress',
    'kitchen porter',
    'kitchen assistant',
    'kitchen team leader',
    'dishwasher',
    'care assistant',
    'support worker',
    'healthcare assistant',
    'activities assistant',
    'catering assistant',
    'prisoner custody officer',
    'postperson',
    'post person',
    'mail sorter',
    'veterinary receptionist',
    'vet receptionist',
    'fragrance associate',
    'beauty advisor',
    'customer service advisor',
    'general assistant',
    'shift lead',
    'shift leader',
    'sales associate',
    'brand ambassador',
    'nandoca',
    'front of house',
    'back of house',
    'crew member',
    'retail assistant',
    'sales assistant',
    'shop assistant',
    'housekeeper',
    'room attendant',
    'cleaner',
];

/** Generic titles hidden only at the employers below. */
const GENERIC_TITLE_PHRASES = ['team member', 'team leader', 'temporary team member'];

const LOW_PROFILE_EMPLOYERS = [
    'greene king',
    'tesco',
    'next',
    'nando',
    'wsh',
    'caterlink',
    'royal mail',
    'bath and body works',
    'asda',
    'sainsbury',
    'aldi',
    'lidl',
    'morrisons',
    'primark',
    'mcdonald',
    'kfc',
    'burger king',
    'costa',
    'starbucks',
    'greggs',
    'wetherspoon',
    'pizza hut',
    'domino',
    'subway',
    'pret a manger',
    'boots',
    'superdrug',
    'poundland',
    'tk maxx',
    'marks and spencer',
];

export function isLowProfileJob(title: string, companyNames: Array<string | null | undefined>): boolean {
    const normalizedTitle = normalize(title);
    if (!normalizedTitle) return false;
    if (TITLE_PHRASES.some((phrase) => normalizedTitle.includes(phrase))) return true;

    const company = normalize(companyNames.filter((name): name is string => Boolean(name)).join(' '));
    if (!company) return false;
    const genericTitle = GENERIC_TITLE_PHRASES.some(
        (phrase) => normalizedTitle === phrase || normalizedTitle.includes(phrase)
    );
    if (!genericTitle) return false;
    return LOW_PROFILE_EMPLOYERS.some((employer) => company.includes(employer));
}

export function isLowProfilePortalJob(job: {
    title?: string | null;
    listingEvidence?: { checksVersion: string };
    company?: { trading_name?: string | null; companies_house_name?: string | null } | null;
}): boolean {
    // The quality relation applies its catalogue scope before counts and pagination.
    if (job.listingEvidence?.checksVersion === 'content-v1') return false;
    return isLowProfileJob(job.title || '', [
        job.company?.trading_name,
        job.company?.companies_house_name,
    ]);
}
