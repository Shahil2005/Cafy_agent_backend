import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptCareerContext } from './careerMatchCursor';
import { careerMatchInputSchema, runCareerMatches, type CareerMatchContext, type CareerMatchDependencies } from './careerMatchService';
import type { StoredCareerFit } from './careerMatchFit';
import type { CareerGroundedContext } from './careerMatchService';
import type { CareerProfile } from './careerMatchTypes';
import { ChatGoogleWebError, type ChatGroundedWeb } from './chatGoogleDiscovery';
import type { ChatSearch } from './chatIntent';
import type { JobsPortalJob } from './types';

const secret = 'fictional-google-secret-for-pure-tests-0123456789';
const now = Date.parse('2026-10-28T12:00:00Z');
const context: CareerMatchContext = { userId: 'fictional-student', country: 'uk', careerPremium: true, partTimePremium: false, partTimeBlocked: false };
const resumeText = 'Worked as a Software Engineer. Built Python reporting projects. Used SQL for financial reporting. PRIVATE-CV-SENTINEL';
const profile: CareerProfile = {
    summary: 'You are an early-career engineer who builds Python reporting tools. PRIVATE-SUMMARY-SENTINEL.',
    level: 'early-career',
    skills: [{ name: 'Python', evidence: 'Built Python reporting projects.' }, { name: 'SQL', evidence: 'Used SQL for financial reporting.' }],
    roles: [{ title: 'Software Engineer', evidence: 'Worked as a Software Engineer.' }],
    projects: [{ label: 'Python reporting', evidence: 'Built Python reporting projects.' }],
    searchDirections: [{ title: 'Data Analyst', evidence: ['Used SQL for financial reporting.'], skills: ['SQL'] }],
};
const start = (extra: Record<string, unknown> = {}) => careerMatchInputSchema.parse({ resumeText, ...extra });
const row = (id: string): JobsPortalJob => ({
    id, title: 'Software Engineer', url: `https://careers.fictional-employer.co.uk/adverts/${id}`, location: 'London',
    description: 'Develop Python services and SQL reporting. Test the applications and document project progress for the team.',
    created_at: '', company_id: 1, company: { id: 1, trading_name: 'Fictional Employer', licensed_sponsor: false,
        companies_house_name: null, url: null, url_linkedin: null, url_favicon: null, description: '',
        estimated_num_employees_label: null, ireland_permit_employer: false, cos_used_count_2025: null,
        open_to_sponsorship: null, show_recently_added_badge: false, added_to_register: null },
});
const card = (url: string, title = 'Software Engineer') => ({
    title, employer: 'Fictional Web Employer', location: 'London', salary: null, employmentType: null, workingArrangement: null,
    description: 'Builds Python services for an internal team.', closingDate: null, postedDate: null, url,
    explanation: 'The advert names the requested role and location. Confirm availability.', sourceIndexes: [0],
});
const grounded = (urls: string[]): ChatGroundedWeb => ({
    text: JSON.stringify({ cards: urls.map((_, sourceId) => ({ sourceId })) }), retrievedAt: new Date(now).toISOString(),
    format: 'job-cards', cards: urls.map((url) => card(url)), retrievedUrls: urls, cardSourceUrls: urls,
    sources: urls.map((url) => ({ url, title: 'Fictional advert' })), citations: [],
    searchQueries: ['software engineer jobs London'], searchSuggestions: [{ label: 'software engineer jobs', url: 'https://www.google.com/search?q=software+engineer+jobs' }],
    searchResearch: { text: 'Fictional research.', sources: [], citations: [] },
});
const noWeb = async () => ({ jobs: [], references: {}, coverage: { examined: 0, candidates: 0,
    sourcesChecked: 0, sourcesFailed: 0, sourcesAvailable: 2, limitReached: false } });

function fixture(catalogueSize: number, google: (search: ChatSearch, timeoutMs: number) => Promise<ChatGroundedWeb>) {
    const catalogue = Array.from({ length: catalogueSize }, (_, i) => row(`c-${String(i).padStart(2, '0')}`));
    const calls: Array<{ search: ChatSearch; timeoutMs: number; context?: CareerGroundedContext }> = [];
    const deps: CareerMatchDependencies = {
        cursorSecret: secret, now: () => now, webCollect: noWeb,
        extract: async () => profile,
        collect: async () => ({ jobs: catalogue, coverage: { catalogueScanned: catalogueSize, candidates: catalogueSize, sourceFailures: 0, limitReached: false } }),
        reload: async (ids) => catalogue.filter((job) => ids.includes(job.id)),
        groundedSearch: async (search, country, options) => {
            assert.equal(country, 'uk');
            calls.push({ search, timeoutMs: options.timeoutMs, context: options.context });
            return google(search, options.timeoutMs);
        },
    };
    return { deps, calls, catalogue };
}

test('a sparse catalogue adds one transient Google round beside the CV matches, sending only occupation criteria', async () => {
    const f = fixture(2, async () => grounded(['https://jobs.fictional-web.co.uk/role/1', 'https://jobs.fictional-web.co.uk/role/2']));
    const page = await runCareerMatches(start(), context, f.deps);
    assert.equal(f.calls.length, 1);
    // Without a chosen role, Google gets the CV's leading occupation query, never CV text.
    assert.equal(f.calls[0]!.search.role, 'Data Analyst');
    assert.ok(f.calls[0]!.timeoutMs >= 12_000 && f.calls[0]!.timeoutMs <= 30_000);
    assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE-CV-SENTINEL|Built Python reporting/);
    assert.equal(page.jobs.length, 2); assert.equal(page.groundedWebStatus, 'searched');
    assert.equal(page.groundedWeb?.cards?.length, 2);
    assert.match(page.message, /searched Google: 2 more adverts are below/);
    assert.match(page.message, /They aren’t scored yet/);
    // Google gets titles, career stage and a few skill names, never the summary or CV quotes.
    assert.deepEqual(f.calls[0]!.context, { roleTitles: ['Data Analyst', 'Software Engineer'], level: 'early-career', skills: ['Python', 'SQL'] });
    assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE-SUMMARY-SENTINEL/);
    // Google content never enters CV ranking, the context token or the continuation token.
    const remembered = decryptCareerContext(page.contextCursor, context.userId, context.country, secret, now);
    assert.equal(remembered.groundedChecked, true);
    assert.doesNotMatch(JSON.stringify(remembered), /fictional-web|Fictional Web Employer|Fictional research/);
    assert.ok(page.jobs.every(({ job }) => !job.url.includes('fictional-web')));
});

test('Google is not used when the catalogue already has five supported CV matches', async () => {
    const f = fixture(12, async () => { throw new Error('must not run'); });
    const page = await runCareerMatches(start(), context, f.deps);
    assert.equal(f.calls.length, 0); assert.equal(page.jobs.length, 5);
    assert.equal(page.groundedWeb, undefined); assert.equal(page.groundedWebStatus, undefined);
});

test('Google also runs when the catalogue has many matches but fewer than five share enough of the CV', async () => {
    const f = fixture(12, async () => grounded(['https://jobs.fictional-web.co.uk/role/5']));
    // Each advert shares only Python; an aligned unscored match needs two shared skills.
    f.catalogue.forEach((job) => { job.description = 'Develop Python services. Test the applications and document project progress for the team.'; });
    const page = await runCareerMatches(start(), context, f.deps);
    assert.equal(f.calls.length, 1); assert.equal(page.jobs.length, 5);
    assert.ok(page.jobs.every(({ matchedSkills }) => matchedSkills.length === 1));
    assert.equal(page.groundedWeb?.cards?.length, 1);
});

test('a continuation of weak fit scores adds one Google round before the shortlist runs out', async () => {
    // 86 overall for the first five; 54 (shown, but not a close match) for the rest.
    const fitOf = (strong: boolean): StoredCareerFit => strong
        ? { role: 9, level: 9, skills: 8, field: 8 } : { role: 6, level: 5, skills: 5, field: 5 };
    const f = fixture(12, async () => grounded(['https://jobs.fictional-web.co.uk/role/6']));
    f.deps.assessFit = async (_profile, jobs) => new Map(jobs.map((job) => [job.id, fitOf(job.id < 'c-05')]));
    const first = await runCareerMatches(start(), context, f.deps);
    assert.equal(f.calls.length, 0); assert.deepEqual(first.jobs.map(({ fit }) => fit?.score), [86, 86, 86, 86, 86]);
    const second = await runCareerMatches({ cursor: first.nextCursor! }, context, f.deps);
    assert.equal(second.jobs.length, 5); assert.ok(second.nextCursor);
    assert.ok(second.jobs.every(({ fit }) => fit!.score < 55));
    assert.equal(f.calls.length, 1); assert.equal(second.groundedWeb?.cards?.length, 1);
    const third = await runCareerMatches({ cursor: second.nextCursor! }, context, f.deps);
    assert.equal(f.calls.length, 1); assert.equal(third.groundedWeb, undefined);
});

test('includeWeb false and a missing Google configuration both skip the paid round', async () => {
    const off = fixture(1, async () => { throw new Error('must not run'); });
    const page = await runCareerMatches(start({ includeWeb: false }), context, off.deps);
    assert.equal(off.calls.length, 0); assert.equal(page.groundedWebStatus, undefined);
    const unconfigured = fixture(1, async () => grounded([]));
    delete unconfigured.deps.groundedSearch;
    assert.equal((await runCareerMatches(start(), context, unconfigured.deps)).groundedWebStatus, undefined);
});

test('a sponsorship filter is reported as skipped without calling Google', async () => {
    const f = fixture(1, async () => { throw new Error('must not run'); });
    const search = { role: 'Software Engineer', where: '', kind: 'career', sponsorship: 'licensed-employer' };
    const page = await runCareerMatches(start({ search }), context, f.deps);
    assert.equal(f.calls.length, 0); assert.equal(page.groundedWebStatus, 'skipped');
    assert.equal(page.groundedWeb, undefined);
});

test('Google failures and too little remaining time never hide CV matches or leak provider detail', async () => {
    const failing = fixture(2, async () => { throw new ChatGoogleWebError('UNGROUNDED', 'invalid-adverts'); });
    const page = await runCareerMatches(start(), context, failing.deps);
    assert.equal(page.jobs.length, 2); assert.equal(page.groundedWebStatus, 'unavailable');
    assert.match(page.message, /tried Google as well, but that search didn’t come back/);
    const crashing = fixture(0, async () => { throw new Error('PRIVATE-PROVIDER-DETAIL'); });
    const empty = await runCareerMatches(start(), context, crashing.deps);
    assert.equal(empty.state, 'no-matches'); assert.equal(empty.groundedWebStatus, 'unavailable');
    assert.doesNotMatch(JSON.stringify(empty), /PRIVATE-PROVIDER-DETAIL/);
    const slow = fixture(1, async () => { throw new Error('must not run'); });
    // The route budget starts at the first clock read; every later read is 45s on.
    const realNow = Date.now;
    const begun = realNow();
    let first = true;
    try {
        Date.now = () => { const value = first ? begun : begun + 45_000; first = false; return value; };
        const late = await runCareerMatches(start(), context, slow.deps);
        assert.equal(slow.calls.length, 0); assert.equal(late.groundedWebStatus, undefined);
        assert.equal(decryptCareerContext(late.contextCursor, context.userId, context.country, secret, now).groundedChecked, undefined);
    } finally { Date.now = realNow; }
});

test('no-matches shows Google adverts with CV-based next directions instead of a dead end', async () => {
    const f = fixture(0, async () => grounded(['https://jobs.fictional-web.co.uk/role/9']));
    const page = await runCareerMatches(start({ search: { role: 'Software Engineer', where: 'London', kind: 'career' } }), context, f.deps);
    assert.equal(page.state, 'no-matches'); assert.equal(page.hasMore, false);
    assert.equal(page.groundedWeb?.cards?.length, 1);
    assert.match(page.message, /one more advert is below/);
    assert.match(page.message, /for Software Engineer in London/);
    assert.match(page.message, /Data Analyst could suit you too/);
});

test('Google duplicates of a returned CV match are removed from the web section', async () => {
    const f = fixture(1, async () => grounded(['https://careers.fictional-employer.co.uk/adverts/c-00', 'https://jobs.fictional-web.co.uk/role/3']));
    const page = await runCareerMatches(start(), context, f.deps);
    assert.deepEqual(page.groundedWeb?.cards?.map((item) => item.url), ['https://jobs.fictional-web.co.uk/role/3']);
});

test('when a continuation runs out of shortlist, Google is tried once and never again for that search', async () => {
    const f = fixture(7, async () => grounded(['https://jobs.fictional-web.co.uk/role/4']));
    const first = await runCareerMatches(start(), context, f.deps);
    assert.equal(f.calls.length, 0); assert.equal(first.jobs.length, 5); assert.ok(first.nextCursor);
    assert.match(first.message, /Show me five more/);
    const second = await runCareerMatches({ cursor: first.nextCursor! }, context, f.deps);
    assert.equal(second.jobs.length, 2); assert.equal(f.calls.length, 1);
    assert.equal(second.groundedWeb?.cards?.length, 1);
    assert.match(second.message, /Let’s keep going/);
    const again = await runCareerMatches({ contextCursor: second.contextCursor, message: 'more' }, context, f.deps);
    assert.equal(f.calls.length, 1); assert.equal(again.groundedWeb, undefined);
});

test('first-batch messages are personal, evidence-only and deterministic per page', async () => {
    const f = fixture(12, async () => grounded([]));
    const page = await runCareerMatches(start(), context, f.deps);
    assert.match(page.message, /these are the five that suit your background best/);
    // The opening is the reviewed CV summary, not a skills list.
    assert.match(page.message, /^I’ve (?:read your whole CV|been through your whole CV|had a proper read of your CV)\.?,? ?(?:Thanks, )?.*You are an early-career engineer/);
    assert.doesNotMatch(page.message, /Why you|Worth knowing|couldn’t find on your CV|honestly/);
    assert.match(page.message, /Software Engineer at Fictional Employer: Python and SQL appear in both your CV and the advert/);
    assert.match(page.message, /Show me five more/);
    assert.doesNotMatch(page.message, /%|perfect|guarantee|eligible|Give me five more/i);
    const replay = await runCareerMatches(start(), context, f.deps);
    assert.equal(replay.message, page.message);
    const next = await runCareerMatches({ cursor: page.nextCursor! }, context, f.deps);
    assert.match(next.message, /five more|Five more/);
    assert.match(next.message, /This set leans on your Python and SQL/);
});

test('a role-less CV review asks for a direction without suggesting unverified ones', async () => {
    const f = fixture(0, async () => grounded([]));
    const page = await runCareerMatches(start(), context, { ...f.deps, extract: async () => ({ ...profile, roles: [], searchDirections: [] }) });
    assert.equal(page.state, 'needs-role'); assert.equal(f.calls.length, 0);
    assert.match(page.message, /whole CV\. You are an early-career engineer who builds Python reporting tools\..* What kind of role should I hunt for/);
    const plain = await runCareerMatches(start(), context,
        { ...f.deps, extract: async () => ({ ...profile, summary: undefined, roles: [], searchDirections: [] }) });
    assert.match(plain.message, /clear evidence of Python and SQL\. What kind of role should I hunt for/);
});

test('an explicit role is widened once into equivalent titles, used for CAFY jobs and Google, and reused on later pages', async () => {
    const f = fixture(0, async () => grounded(['https://jobs.fictional-web.co.uk/role/9']));
    const titles = ['Programmer', 'Software Engineer', 'Software Developer', 'Web Developer'];
    // Only Python is shared, so CAFY lacks five close matches and Google runs once.
    const rows = titles.flatMap((title, index) => [row(`d-${index}a`), row(`d-${index}b`)].map((job) => ({ ...job, title,
        description: 'Develop Python services. Test the applications and document project progress for the team.' })));
    const expansions: string[] = [];
    f.deps.expandRole = async (role, _profile, options) => {
        assert.ok(options.timeoutMs <= 6000);
        expansions.push(role);
        return [role, 'Software Developer', 'Software Engineer', 'Programmer'];
    };
    const collected: string[][] = [];
    f.deps.collect = async (_search, _country, queries) => {
        collected.push(queries);
        return { jobs: rows, coverage: { catalogueScanned: rows.length, candidates: rows.length, sourceFailures: 0, limitReached: false } };
    };
    f.deps.reload = async (ids) => rows.filter((job) => ids.includes(job.id));
    const search = { role: 'developer', where: '', kind: 'career' };
    const page = await runCareerMatches(start({ search }), context, f.deps);
    assert.deepEqual(expansions, ['developer']);
    assert.deepEqual(collected[0], ['developer', 'Software Developer', 'Software Engineer', 'Programmer']);
    // "Developer" finds programmers and engineers too, not only titles containing the word.
    assert.deepEqual(new Set(page.jobs.map(({ job }) => job.title)).size > 1, true);
    assert.ok(page.jobs.some(({ job }) => job.title === 'Programmer' || job.title === 'Software Engineer'));
    assert.deepEqual(f.calls[0]?.context?.roleTitles, ['developer', 'Software Developer', 'Software Engineer', 'Programmer']);
    const next = await runCareerMatches({ cursor: page.nextCursor! }, context, f.deps);
    assert.equal(next.jobs.length, 3);
    assert.deepEqual(new Set([...page.jobs, ...next.jobs].map(({ job }) => job.id)).size, 8);
    // A follow-up for the same role reuses the family without another AI call.
    await runCareerMatches(careerMatchInputSchema.parse({ contextCursor: next.contextCursor, search: { ...search, where: 'London' } }),
        context, f.deps);
    assert.deepEqual(expansions, ['developer']);
});

test('a failed role expansion still searches the literal role', async () => {
    const f = fixture(3, async () => grounded([]));
    f.deps.expandRole = async () => { throw new Error('PRIVATE-PROVIDER-DETAIL'); };
    const queries: string[][] = [];
    const collect = f.deps.collect!;
    f.deps.collect = async (search, country, roles, deps) => { queries.push(roles); return collect(search, country, roles, deps); };
    const page = await runCareerMatches(start({ search: { role: 'Software Engineer', where: '', kind: 'career' } }), context, f.deps);
    assert.deepEqual(queries, [['Software Engineer']]);
    assert.equal(page.jobs.length, 3);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE-PROVIDER-DETAIL/);
});
