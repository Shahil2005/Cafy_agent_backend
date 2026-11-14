import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobChatInputSchema } from './chatIntent';
import { runJobChat, type JobChatContext, type JobChatDependencies } from './chatService';
import { ChatGoogleWebError, type ChatGroundedWeb } from './chatGoogleDiscovery';
import { toPublicPortalJob } from './publicResponse';

const paid: JobChatContext = {
    catalogCountry: 'uk',
    careerPremium: true,
    partTimePremium: true,
    partTimeBlocked: false,
};
const research: ChatGroundedWeb = {
    text: 'Original provider research with its own attribution.',
    sources: [{ title: 'Employer careers', url: 'https://employer.example/careers' }],
    citations: [{ startIndex: 0, endIndex: 17, sourceIndexes: [0] }],
    searchQueries: ['data analyst jobs London'],
    searchSuggestions: [
        { label: 'data analyst jobs London', url: 'https://www.google.com/search?q=data+analyst+jobs+London' },
    ],
    retrievedAt: new Date().toISOString(),
};
const input = (message = 'Find data analyst jobs in London', includeWeb = true) =>
    jobChatInputSchema.parse({ message, includeWeb });
function dependencies(overrides: Partial<JobChatDependencies> = {}): JobChatDependencies {
    const empty = async () => ({ jobs: [], totalCount: 0, totalPages: 1, globalTotalCount: 0 });
    return {
        careerFeed: empty,
        partTimeFeed: empty,
        webFeed: async () => ({
            jobs: [],
            examined: 20,
            excluded: 20,
            retrievedAt: research.retrievedAt,
            cacheHit: false,
            boardsChecked: 2,
            boardsFailed: 1,
            boardsAvailable: 7,
            limitReached: true,
        }),
        groundedSearch: async () => research,
        ...overrides,
    };
}

const matchingJob = (web = false) => toPublicPortalJob({
    id: web ? `web:${'a'.repeat(64)}` : 'catalogue-analyst',
    title: 'Data Analyst',
    location: 'London',
    url: `https://employer.example/jobs/${web ? 'web-analyst' : 'catalogue-analyst'}`,
    description: `Analyse reporting for the ${web ? 'employer advert' : 'catalogue advert'} team.`,
    company_id: 4,
    company: { id: 4, trading_name: 'Example Employer', licensed_sponsor: true },
    created_at: research.retrievedAt,
    ...(web ? {
        listingSource: {
            kind: 'web',
            provider: 'employer-sites',
            retrievedAt: research.retrievedAt,
            availability: 'source-listed',
            employerLicence: 'catalogue-match',
        },
    } : {}),
});

function matchingDependencies(overrides: Partial<JobChatDependencies> = {}): JobChatDependencies {
    return dependencies({
        careerFeed: async () => ({
            jobs: [matchingJob()], totalCount: 1, totalPages: 1, globalTotalCount: 1,
            evidence: { 'catalogue-analyst': ['Role keywords match the listing title.'] },
        }),
        webFeed: async () => ({
            jobs: [matchingJob(true)], examined: 1, excluded: 0,
            retrievedAt: research.retrievedAt, cacheHit: false,
        }),
        ...overrides,
    });
}

test('Google research is display-only, independent of matching cards and deterministic history message', async () => {
    const result = await runJobChat(input(), paid, dependencies());
    assert.deepEqual(result.groundedWeb, research);
    assert.equal(result.groundedWebStatus, 'searched');
    assert.equal(result.totalCount, 0);
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.evidence, {});
    assert.ok(!result.message.includes(research.text));
    assert.ok(!result.message.includes(research.sources[0]!.url));
    assert.equal(result.web?.provider, 'employer-sites');
    assert.equal(result.web?.boardsChecked, 2);
    assert.equal(result.web?.boardsFailed, 1);
    assert.equal(result.web?.boardsAvailable, 7);
    assert.equal(result.web?.limitReached, true);
    assert.match(result.message, /individual adverts on the web/);
    assert.ok(result.message.length < 600);
    assert.doesNotMatch(result.message, /posted within the last seven days/);
});

test('Google research and employer-feed failures do not depend on each other', async () => {
    const withResearch = await runJobChat(
        input(),
        paid,
        dependencies({
            webFeed: async () => {
                throw new Error();
            },
        }),
    );
    assert.equal(withResearch.web?.status, 'unavailable');
    assert.equal(withResearch.groundedWebStatus, 'searched');
    assert.deepEqual(withResearch.groundedWeb, research);
    const withFeed = await runJobChat(
        input(),
        paid,
        dependencies({
            groundedSearch: async () => {
                throw new Error('private');
            },
        }),
    );
    assert.equal(withFeed.web?.status, 'searched');
    assert.equal(withFeed.groundedWebStatus, 'unavailable');
    assert.equal(withFeed.groundedWeb, undefined);
    assert.doesNotMatch(withFeed.message, /private/);
});

test('off, free preview, clarification and country conflicts gate BOTH external sources', async () => {
    let calls = 0;
    const deps = dependencies({
        webFeed: async () => {
            calls++;
            throw new Error();
        },
        groundedSearch: async () => {
            calls++;
            throw new Error();
        },
    });
    const off = await runJobChat(input(undefined, false), paid, deps);
    assert.equal(off.groundedWebStatus, 'not_requested');
    const free = await runJobChat(input(), { ...paid, careerPremium: false }, deps);
    assert.equal(free.groundedWebStatus, 'premium_required');
    assert.equal(free.web?.status, 'premium_required');
    for (const message of ['Find jobs within 10 miles of London', 'Find jobs in Ireland']) {
        const result = await runJobChat(input(message), paid, deps);
        assert.equal(result.groundedWebStatus, 'skipped');
        assert.equal(result.groundedWeb, undefined);
        assert.equal(result.web?.status, 'skipped');
    }
    assert.equal(calls, 0);
});

test('missing Google configuration does not disable keyless employer retrieval', async () => {
    const result = await runJobChat(input(), paid, dependencies({ groundedSearch: undefined }));
    assert.equal(result.web?.status, 'searched');
    assert.equal(result.groundedWebStatus, 'unavailable');
    assert.equal(result.groundedWeb, undefined);
    assert.match(result.message, /Google Search is not configured on this server/);
});

test('inherited sponsorship keeps exact catalogue and employer filters while unsupported Google search is skipped', async () => {
    const request = jobChatInputSchema.parse({
        ...input('same jobs'),
        search: { role: 'data analyst', where: 'London', kind: 'career', sponsorship: 'licensed-employer' },
    });
    let catalogueCalls = 0;
    let googleCalls = 0;
    const result = await runJobChat(request, paid, matchingDependencies({
        careerFeed: async (search) => {
            catalogueCalls++;
            assert.equal(search.sponsorship, 'licensed-employer');
            return { jobs: [matchingJob()], totalCount: 1, totalPages: 1, globalTotalCount: 1 };
        },
        groundedSearch: async (search) => {
            googleCalls++;
            assert.equal(search.sponsorship, 'licensed-employer');
            throw new ChatGoogleWebError('UNSUPPORTED');
        },
    }));
    assert.equal(catalogueCalls, 1);
    assert.equal(googleCalls, 1);
    assert.equal(result.search.sponsorship, 'licensed-employer');
    assert.equal(result.groundedWebStatus, 'skipped');
    assert.equal(result.groundedWeb, undefined);
    assert.equal(result.web?.status, 'searched');
    assert.equal(result.web?.returned, 1);
    assert.equal(result.jobs.length, 2);
    assert.match(result.message, /Google Search was not run because it cannot establish CAFY’s sponsor-licence or advert sponsorship evidence/);
    assert.match(result.message, /sponsorship filter remains applied to the catalogue and employer adverts/);
    assert.doesNotMatch(result.message, /web lookup couldn’t return/);
});

for (const [reason, copy] of [
    ['search-evidence', /did not provide the source evidence/],
    ['retrieval-evidence', /could not retrieve supported individual adverts/],
    ['invalid-adverts', /did not pass CAFY’s source, date or filter checks/],
    ['rate-limited', /temporarily rate-limited/],
    ['provider-unavailable', /search service could not complete this lookup/],
] as const) {
    test(`typed Google ${reason} failure explains the cause without discarding independent results`, async () => {
        const result = await runJobChat(input(), paid, matchingDependencies({
            groundedSearch: async () => {
                throw new ChatGoogleWebError(reason === 'rate-limited' || reason === 'provider-unavailable' ? 'UNAVAILABLE' : 'UNGROUNDED', reason);
            },
        }));
        assert.equal(result.groundedWebStatus, 'unavailable');
        assert.equal(result.groundedWeb, undefined);
        assert.equal(result.catalogueStatus, 'searched');
        assert.equal(result.web?.status, 'searched');
        assert.equal(result.web?.returned, 1);
        assert.equal(result.jobs.length, 2);
        assert.match(result.message, copy);
        assert.deepEqual(Object.keys(result.evidence).sort(), result.jobs.map((job) => job.id).sort());
    });
}

test('untrusted error properties and text cannot select public failure explanations', async () => {
    const result = await runJobChat(input(), paid, matchingDependencies({
        groundedSearch: async () => {
            throw Object.assign(new Error('private provider response and credentials'), { code: 'UNSUPPORTED', reason: 'rate-limited' });
        },
    }));
    assert.equal(result.groundedWebStatus, 'unavailable');
    assert.equal(result.jobs.length, 2);
    assert.match(result.message, /web lookup couldn’t return supported individual adverts/);
    assert.doesNotMatch(result.message, /private|credentials|rate-limited|Google Search was not run/);
});

test('a completed Google search with no supported adverts remains searched instead of unavailable', async () => {
    const result = await runJobChat(input(), paid, matchingDependencies({
        groundedSearch: async () => ({ ...research, format: 'job-cards', cards: [] }),
    }));
    assert.equal(result.groundedWebStatus, 'searched');
    assert.deepEqual(result.groundedWeb?.cards, []);
    assert.equal(result.jobs.length, 2);
    assert.match(result.message, /Google Search completed, but it could not support individual adverts for these filters/);
});
