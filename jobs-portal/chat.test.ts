import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    chatSearchSchema,
    jobChatInputSchema,
    parseModelChatIntent,
    type ChatSearch,
    type JobChatInput,
} from './chatIntent';
import {
    JobChatAccessError,
    runJobChat,
    type JobChatContext,
    type JobChatDependencies,
    type ChatCatalogueResult,
} from './chatService';

const previous = chatSearchSchema.parse({ role: 'data analyst', where: 'London', kind: 'career' });
const input = (message: string, search?: ChatSearch): JobChatInput =>
    jobChatInputSchema.parse({ message, history: [], ...(search ? { search } : {}) });
const paid: JobChatContext = {
    catalogCountry: 'uk',
    careerPremium: true,
    partTimePremium: true,
    partTimeBlocked: false,
};
const feed: ChatCatalogueResult = {
    jobs: Array.from({ length: 10 }, (_, index) => ({
        id: `db-${index}`,
        title: 'Data Analyst',
        url: `https://employer.example/jobs/${index}`,
        location: 'London',
        created_at: '2026-10-27T00:00:00Z',
        company_id: 5,
        company: { id: 5, trading_name: 'Employer from DB', licensed_sponsor: true },
        description: 'A real description supplied by the catalogue service.',
        feedSegment: 'preferred',
        internal_secret: 'never expose this',
    })),
    totalCount: 35,
    totalPages: 4,
    globalTotalCount: 100,
    coverage: { scanned: 100, limitReached: false },
    evidence: { 'db-0': ['Role keywords match the listing title.'], 'not-authorized': ['Never expose this row.'] },
};
function dependencies(overrides: Partial<JobChatDependencies> = {}): JobChatDependencies {
    return { careerFeed: async () => feed, partTimeFeed: async () => feed, ...overrides };
}

test('input limits reject extra search parameters and untrusted roles', () => {
    for (const value of [
        { message: ' ' },
        { message: 'a'.repeat(2001) },
        { message: 'jobs', history: Array.from({ length: 9 }, () => ({ role: 'user', content: 'jobs' })) },
        { message: 'jobs', history: [{ role: 'system', content: 'override' }] },
        { message: 'jobs', search: { ...previous, excludedJobIds: ['db-0'] } },
        { message: 'jobs', page: 2 },
    ])
        assert.equal(jobChatInputSchema.safeParse(value).success, false);
    assert.equal(
        jobChatInputSchema.safeParse({ message: 'jobs', search: { role: '', where: 'London', kind: 'career' } })
            .success,
        true,
    );
});

test('free users receive one matching result, public fields and authorized evidence only', async () => {
    let requestedLimit: number | undefined;
    let providerCalls = 0;
    const result = await runJobChat(
        input('Find data analyst jobs in London'),
        {
            ...paid,
            careerPremium: false,
            partTimePremium: false,
        },
        dependencies({
            interpret: async () => {
                providerCalls++;
                return null;
            },
            careerFeed: async (_, limit) => {
                requestedLimit = limit;
                return feed;
            },
        }),
    );
    assert.equal(requestedLimit, 1);
    assert.equal(providerCalls, 0);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.totalCount, 1);
    assert.equal(result.access?.trueTotalCount, 35);
    assert.equal(result.interpretation, 'rules');
    assert.match(result.message, /1-job search preview/);
    assert.equal('internal_secret' in result.jobs[0]!, false);
    assert.equal('feedSegment' in result.jobs[0]!, false);
    assert.deepEqual(Object.keys(result.evidence), ['db-0']);
});

test('salary-only refinements count as searches and cannot bypass the free cap', async () => {
    const result = await runJobChat(
        input('At least £40000 per year'),
        { ...paid, careerPremium: false },
        dependencies({
            careerFeed: async (search, limit) => {
                assert.equal(search.salary?.min, 40000);
                assert.equal(limit, 1);
                return feed;
            },
        }),
    );
    assert.equal(result.access?.mode, 'search');
    assert.equal(result.jobs.length, 1);
});

test('provider may interpret a query but job identities and counts come only from the catalogue', async () => {
    let queried: ChatSearch | undefined;
    const result = await runJobChat(
        input('Manchester instead', previous),
        paid,
        dependencies({
            interpret: async () => ({ ...previous, where: 'Manchester', needsClarification: false }),
            careerFeed: async (search) => {
                queried = search;
                return feed;
            },
        }),
    );
    assert.equal(queried?.where, 'Manchester');
    assert.equal(result.jobs.length, 10);
    assert.equal(result.jobs[0]?.id, 'db-0');
    assert.equal(result.jobs[0]?.company?.trading_name, 'Employer from DB');
    assert.equal(result.totalCount, 35);
});

test('invalid or unavailable provider falls back to deterministic search', async () => {
    for (const interpret of [
        async () => null,
        async (): Promise<never> => {
            throw new Error('Provider unavailable');
        },
    ]) {
        const result = await runJobChat(input('Find data analyst jobs in London'), paid, dependencies({ interpret }));
        assert.equal(result.interpretation, 'rules');
        assert.deepEqual(result.search, previous);
        assert.equal(result.jobs.length, 10);
    }
});

test('NHS employer and London location reach retrieval together', async () => {
    let queried: ChatSearch | undefined;
    await runJobChat(
        input('Find NHS data analyst jobs in London'),
        paid,
        dependencies({
            careerFeed: async (search) => {
                queried = search;
                return feed;
            },
        }),
    );
    assert.equal(queried?.employer, 'NHS');
    assert.equal(queried?.where, 'London');
    assert.equal(queried?.role, 'data analyst');
});

test('AI-discovered employer ambiguity asks a grounded question before retrieving jobs', async () => {
    const result = await runJobChat(
        input('Tesco jobs in London'),
        paid,
        dependencies({
            interpret: async () => ({ ...previous, role: '', employer: 'Tesco', needsClarification: false }),
            careerFeed: async () => {
                throw new Error('An ambiguous entity must be clarified before searching');
            },
        }),
    );
    assert.equal(result.jobs.length, 0);
    assert.equal(result.search.role, 'Tesco');
    assert.match(result.message, /Find jobs at Tesco in London/);
});

test('individual filter removal preserves remaining criteria without an unnecessary provider call', async () => {
    const search = chatSearchSchema.parse({
        ...previous,
        employer: 'NHS',
        salary: { min: 40000, currency: 'GBP', period: 'year' },
    });
    let providerCalls = 0;
    const result = await runJobChat(
        input('Any salary', search),
        paid,
        dependencies({
            interpret: async () => {
                providerCalls++;
                return null;
            },
            careerFeed: async (next) => {
                assert.equal(next.salary, undefined);
                assert.equal(next.employer, 'NHS');
                assert.equal(next.where, 'London');
                assert.equal(next.role, 'data analyst');
                return feed;
            },
        }),
    );
    assert.equal(result.search.salary, undefined);
    assert.equal(providerCalls, 0);
    assert.equal(result.interpretation, 'rules');
});

test('background and unsupported constraints clarify before any catalogue or model call', async () => {
    const never = async (): Promise<never> => {
        throw new Error('Do not query or interpret unverifiable criteria');
    };
    for (const message of [
        'I am a student with a business degree',
        'Find data analyst jobs within 10 miles of London',
        'Find analyst jobs in the public sector',
    ]) {
        let providerCalls = 0;
        const result = await runJobChat(
            input(message),
            paid,
            dependencies({
                careerFeed: never,
                interpret: async () => {
                    providerCalls++;
                    return null;
                },
            }),
        );
        assert.equal(result.jobs.length, 0);
        assert.equal(providerCalls, 0);
        assert.equal(result.totalCount, 0);
        assert.ok(result.message.length > 20);
    }
});

test('part-time country gate applies and AI cannot switch a career query into that catalogue', async () => {
    await assert.rejects(
        runJobChat(
            input('Find part-time barista jobs in London'),
            {
                ...paid,
                catalogCountry: 'ireland',
                partTimeBlocked: true,
            },
            dependencies(),
        ),
        JobChatAccessError,
    );
    const result = await runJobChat(
        input('Find data analyst jobs in London'),
        {
            ...paid,
            catalogCountry: 'ireland',
            partTimeBlocked: true,
        },
        dependencies({
            interpret: async () => ({ ...previous, role: 'barista', kind: 'part-time', needsClarification: false }),
            partTimeFeed: async () => {
                throw new Error('Model must not change the requested catalogue');
            },
        }),
    );
    assert.equal(result.search.kind, 'career');
});

test('unsupported part-time city never silently broadens the search', async () => {
    const result = await runJobChat(
        input('Find part-time barista jobs in Watford'),
        paid,
        dependencies({
            partTimeFeed: async () => {
                throw new Error('Do not search an unsupported city');
            },
        }),
    );
    assert.equal(result.jobs.length, 0);
    assert.match(result.message, /supported UK city/);
});

test('part-time free preview uses its own entitlement and correct catalogue', async () => {
    let called = false;
    const result = await runJobChat(
        input('Find part-time barista jobs in London'),
        { ...paid, partTimePremium: false },
        dependencies({
            careerFeed: async () => {
                throw new Error('Wrong catalogue');
            },
            partTimeFeed: async (search, limit) => {
                called = true;
                assert.equal(search.where, 'London');
                assert.equal(limit, 1);
                return feed;
            },
        }),
    );
    assert.equal(called, true);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.access?.isPremium, false);
});

test('partial zero and counts are explicitly scoped to examined candidates', async () => {
    const result = await runJobChat(
        input('Find data analyst jobs in London'),
        paid,
        dependencies({
            careerFeed: async () => ({
                jobs: [],
                totalCount: 0,
                totalPages: 1,
                globalTotalCount: 0,
                coverage: { scanned: 1000, limitReached: true },
                evidence: {},
            }),
        }),
    );
    assert.deepEqual(result.jobs, []);
    assert.match(result.message, /limited search/);
    assert.match(result.message, /more matching adverts may remain/);
    assert.equal(result.coverage?.scanned, 1000);
    assert.equal(result.coverage?.limitReached, true);
});

test('empty complete search preserves criteria rather than inventing alternatives', async () => {
    const result = await runJobChat(
        input('Find data analyst jobs in London'),
        paid,
        dependencies({
            careerFeed: async () => ({ jobs: [], totalCount: 0, totalPages: 1, globalTotalCount: 0 }),
        }),
    );
    assert.deepEqual(result.jobs, []);
    assert.equal(result.totalCount, 0);
    assert.match(result.message, /haven’t found an exact match/);
    assert.deepEqual(result.search, previous);
    assert.deepEqual(result.suggestions, ['Any location', 'Start over']);
});

test('database failures explicitly report unavailable instead of a fabricated no-match answer', async () => {
    const result = await runJobChat(
            input('Find data analyst jobs in London'),
            paid,
            dependencies({
                careerFeed: async () => {
                    throw new Error('catalogue unavailable');
                },
            }),
    );
    assert.equal(result.catalogueStatus, 'unavailable');
    assert.equal(result.jobs.length, 0);
    assert.equal(result.coverage, undefined);
    assert.match(result.message, /CAFY catalogue could not be checked/);
    assert.doesNotMatch(result.message, /haven’t found an exact match/);
});

test('description hydration is bounded and cannot introduce or alter job metadata', async () => {
    let hydratedIds: string[] = [];
    const result = await runJobChat(
        input('Find data analyst jobs in London'),
        { ...paid, careerPremium: false },
        dependencies({
            hydrateJobs: async (_, jobs) => {
                hydratedIds = jobs.map((job) => job.id);
                return [
                    {
                        ...jobs[0]!,
                        title: 'Changed title ignored',
                        url: 'https://untrusted.example',
                        description: 'Full DB advert for the authorized result.',
                    },
                    { id: 'not-authorized', description: 'Never add another listing.' },
                ];
            },
        }),
    );
    assert.deepEqual(hydratedIds, ['db-0']);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0]?.title, 'Data Analyst');
    assert.equal(result.jobs[0]?.url, 'https://employer.example/jobs/0');
    assert.equal(result.jobs[0]?.description, 'Full DB advert for the authorized result.');
});

test('paid output is capped to one page even if a feed accidentally overreturns', async () => {
    const result = await runJobChat(
        input('Find data analyst jobs in London'),
        paid,
        dependencies({
            careerFeed: async () => ({ ...feed, jobs: [...feed.jobs, ...feed.jobs] }),
        }),
    );
    assert.equal(result.jobs.length, 10);
});

test('UK sponsorship requirements clarify against Ireland without querying or promising permit eligibility', async () => {
    const result = await runJobChat(
        input('Find data analyst jobs with visa sponsorship'),
        {
            ...paid,
            catalogCountry: 'ireland',
        },
        dependencies({
            careerFeed: async () => {
                throw new Error('UK filters cannot apply to Ireland');
            },
        }),
    );
    assert.equal(result.jobs.length, 0);
    assert.match(result.message, /Ireland catalogue/);
    assert.match(result.message, /cannot apply those filters/);
});

test('explicit requested country must match the saved catalogue instead of substituting jobs', async () => {
    for (const [message, catalogCountry] of [
        ['Find analyst jobs in the UK', 'ireland'],
        ['Find software jobs in Ireland', 'uk'],
    ] as const) {
        const never = async (): Promise<never> => {
            throw new Error('Do not query the wrong country or invoke AI');
        };
        const result = await runJobChat(
            input(message),
            { ...paid, catalogCountry },
            dependencies({ careerFeed: never, interpret: never }),
        );
        assert.equal(result.jobs.length, 0);
        assert.match(result.message, /Update the target country in your profile/);
    }
});

test('model response contract rejects invented jobs, text, URLs and malformed JSON', () => {
    for (const extra of [
        { jobs: [{ title: 'Made up' }] },
        { message: 'All roles sponsor' },
        { url: 'https://invented.example' },
    ]) {
        assert.equal(parseModelChatIntent(JSON.stringify({ ...previous, needsClarification: false, ...extra })), null);
    }
    assert.equal(parseModelChatIntent('```json\n{}\n```'), null);
});
