import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    EmployerSourceError,
    fetchEmployerBoardJobs,
    parseEmployerBoardUrl,
    type EmployerBoard,
    type EmployerSourceDependencies,
} from './chatEmployerSources';
import type { PublicJobsPortalCompany } from './types';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const DESCRIPTION = '<p>Analyse business data and build clear reports for customers. Salary: £40,000 per annum.</p>';
const BOARD: EmployerBoard = {
    provider: 'greenhouse',
    token: 'actual-board',
    name: 'Actual Analytics Limited',
};
function greenhouse(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 42,
        title: 'Graduate Data Analyst',
        location: { name: 'London, United Kingdom' },
        absolute_url: 'https://job-boards.greenhouse.io/actual-board/jobs/42?utm_source=google',
        content: DESCRIPTION,
        updated_at: '2026-10-26T12:00:00Z',
        departments: [{ name: 'Analytics' }],
        ...fields,
    };
}
function lever(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'posting-id',
        text: 'Junior Data Analyst',
        categories: {
            location: 'Manchester, UK',
            commitment: 'Full-time',
            team: 'Analytics',
        },
        hostedUrl: 'https://jobs.lever.co/actual-board/posting-id',
        descriptionPlain: 'Analyse business data and build clear reports for customers in our analytics department.',
        createdAt: Date.parse('2026-10-20T10:00:00Z'),
        ...fields,
    };
}
function ashby(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'posting-id',
        title: 'Senior Data Analyst',
        location: 'Dublin, Ireland',
        jobUrl: 'https://jobs.ashbyhq.com/actual-board/posting-id',
        descriptionHtml: DESCRIPTION,
        publishedAt: '2026-09-20T10:00:00Z',
        employmentType: 'FullTime',
        ...fields,
    };
}
function deps(payload: unknown, fields: EmployerSourceDependencies = {}): EmployerSourceDependencies {
    return {
        now: () => NOW,
        fetch: async () => Response.json(payload),
        ...fields,
    };
}
function errorCode(code: EmployerSourceError['code']): (error: unknown) => boolean {
    return (error) => error instanceof EmployerSourceError && error.code === code;
}

test('supported public and API URLs retain actual board slug and region', () => {
    const cases: Array<[string, EmployerBoard]> = [
        [
            'https://boards.greenhouse.io/actual-board/jobs/42',
            { provider: 'greenhouse', token: 'actual-board', region: 'global' },
        ],
        [
            'https://job-boards.eu.greenhouse.io/actual-board/jobs/42',
            { provider: 'greenhouse', token: 'actual-board', region: 'eu' },
        ],
        [
            'https://boards.greenhouse.io/embed/job_app?for=actual-board&token=42',
            { provider: 'greenhouse', token: 'actual-board', region: 'global' },
        ],
        [
            'https://boards-api.eu.greenhouse.io/v1/boards/actual-board/jobs',
            { provider: 'greenhouse', token: 'actual-board', region: 'eu' },
        ],
        [
            'https://jobs.eu.lever.co/actual-board/posting-id',
            { provider: 'lever', token: 'actual-board', region: 'eu' },
        ],
        [
            'https://api.eu.lever.co/v0/postings/actual-board',
            { provider: 'lever', token: 'actual-board', region: 'eu' },
        ],
        [
            'https://jobs.ashbyhq.com/actual-board/posting-id',
            { provider: 'ashby', token: 'actual-board', region: 'global' },
        ],
        [
            'https://api.ashbyhq.com/posting-api/job-board/actual-board',
            { provider: 'ashby', token: 'actual-board', region: 'global' },
        ],
    ];
    for (const [url, expected] of cases) assert.deepEqual(parseEmployerBoardUrl(url), expected);
});

test('URLs cannot introduce lookalike hosts, credentials, HTTP, ports or encoded path tokens', () => {
    for (const url of [
        'http://jobs.lever.co/actual-board',
        'https://jobs.lever.co.evil.com/actual-board',
        'https://evil.com/jobs.lever.co/actual-board',
        'https://user:secret@jobs.lever.co/actual-board',
        'https://jobs.lever.co:8443/actual-board',
        'https://jobs.lever.co/actual%2fboard',
        'https://jobs.lever.co/',
        'https://127.0.0.1/actual-board',
        'https://boards.greenhouse.io/embed/job_app?for=https://evil.com',
        'https://jobs.ashbyhq.com/a%0aboard',
        'https://api.ashbyhq.com/arbitrary/actual-board',
        'https://jobs.lever.co/actual board',
    ])
        assert.equal(parseEmployerBoardUrl(url), null, url);
});

test('invalid caller board tokens and regions make no requests', async () => {
    let calls = 0;
    const inject = deps(
        {},
        {
            fetch: async () => {
                calls++;
                throw new Error('must not fetch');
            },
        },
    );
    for (const board of [
        { ...BOARD, token: '../private' },
        { ...BOARD, token: 'a?credential=x' },
        { ...BOARD, token: '' },
        { ...BOARD, region: 'invalid' as 'eu' },
        { ...BOARD, provider: 'other' as 'greenhouse' },
    ]) {
        await assert.rejects(fetchEmployerBoardJobs(board, 'uk', inject), errorCode('INVALID_BOARD'));
    }
    assert.equal(calls, 0);
});

test('Greenhouse GET uses the fixed API, full content, redirect error and a deadline', async () => {
    let calls = 0;
    const result = await fetchEmployerBoardJobs(
        BOARD,
        'uk',
        deps(
            { jobs: [greenhouse()] },
            {
                fetch: async (input, init) => {
                    calls++;
                    assert.equal(
                        String(input),
                        'https://boards-api.greenhouse.io/v1/boards/actual-board/jobs?content=true',
                    );
                    assert.equal(init?.method, 'GET');
                    assert.equal(init?.redirect, 'error');
                    assert.ok(init?.signal);
                    assert.equal(new Headers(init?.headers).has('Authorization'), false);
                    return Response.json({ jobs: [greenhouse()] });
                },
            },
        ),
    );
    assert.equal(calls, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.examined, 1);
    assert.equal(result.excluded, 0);
    assert.equal(result.jobs[0]!.listingSource?.provider, 'employer-sites');
    assert.equal(result.jobs[0]!.listingSource?.availability, 'source-listed');
    assert.equal(result.jobs[0]!.listingSource?.publisher, 'Greenhouse');
    assert.equal(result.jobs[0]!.url, 'https://job-boards.greenhouse.io/actual-board/jobs/42');
    assert.equal(result.jobs[0]!.listingSource?.postedAt, undefined);
    assert.equal(result.jobs[0]!.created_at, '');
    assert.equal(result.jobs[0]!.listingSource?.retrievedAt, new Date(NOW).toISOString());
    assert.equal(result.jobs[0]!.level, 'Entry Level');
});

test('EU Greenhouse uses its documented EU host only', async () => {
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, region: 'eu' },
        'uk',
        deps(
            {},
            {
                fetch: async (input) => {
                    assert.equal(new URL(String(input)).hostname, 'boards-api.eu.greenhouse.io');
                    return Response.json({ jobs: [greenhouse()] });
                },
            },
        ),
    );
    assert.equal(result.jobs.length, 1);
});

test('encoded full advert HTML becomes safe readable text without executable tags', async () => {
    const content =
        '&lt;p&gt;Analyse business data &amp;amp; prepare reports for customers in our analytics department.&lt;/p&gt;&lt;script&gt;secret()&lt;/script&gt;';
    const result = await fetchEmployerBoardJobs(BOARD, 'uk', deps({ jobs: [greenhouse({ content })] }));
    assert.match(result.jobs[0]!.description!, /business data & prepare/);
    assert.doesNotMatch(result.jobs[0]!.description!, /<|secret\(\)/);
});

test('a board without a supplied name uses actual Greenhouse board metadata', async () => {
    let calls = 0;
    const result = await fetchEmployerBoardJobs(
        { provider: 'greenhouse', token: 'actual-board' },
        'uk',
        deps(
            {},
            {
                fetch: async (input) => {
                    calls++;
                    return String(input).includes('/jobs?')
                        ? Response.json({ jobs: [greenhouse()] })
                        : Response.json({ name: 'Verified Board Company' });
                },
            },
        ),
    );
    assert.equal(calls, 2);
    assert.equal(result.jobs[0]!.company?.trading_name, 'Verified Board Company');
});

test('unknown identity never becomes a guessed token or generic ATS name', async () => {
    await assert.rejects(
        fetchEmployerBoardJobs({ provider: 'greenhouse', token: 'actual-board' }, 'uk', deps({ jobs: [] })),
        errorCode('EMPLOYER_UNIDENTIFIED'),
    );
});

test('Lever names can be established by JobPosting hiringOrganization data on the official board', async () => {
    const board: EmployerBoard = { provider: 'lever', token: 'actual-board' };
    const result = await fetchEmployerBoardJobs(
        board,
        'uk',
        deps(
            {},
            {
                fetch: async (input) =>
                    String(input).startsWith('https://api.lever.co/')
                        ? Response.json([lever()])
                        : new Response(
                              '<script type="application/ld+json">{"@type":"JobPosting","hiringOrganization":{"name":"Verified Analytics Company"}}</script>',
                          ),
            },
        ),
    );
    assert.equal(result.jobs[0]!.company?.trading_name, 'Verified Analytics Company');
});

test('conflicting structured employer names on an unknown board are rejected', async () => {
    const html =
        '<script type="application/ld+json">[{"@type":"JobPosting","hiringOrganization":{"name":"A Company"}},{"@type":"JobPosting","hiringOrganization":{"name":"B Company"}}]</script>';
    await assert.rejects(
        fetchEmployerBoardJobs(
            { provider: 'lever', token: 'actual-board' },
            'uk',
            deps(
                {},
                {
                    fetch: async (input) =>
                        String(input).startsWith('https://api.lever.co/')
                            ? Response.json([lever()])
                            : new Response(html),
                },
            ),
        ),
        errorCode('EMPLOYER_UNIDENTIFIED'),
    );
});

test('Lever includes all named advert sections and explicit structured pay units', async () => {
    const row = lever({
        salaryRange: { min: 40000, max: 50000, currency: 'GBP', interval: 'year' },
        lists: [
            {
                text: 'Requirements',
                content: '<p>Experience with SQL and reporting for stakeholders.</p>',
            },
        ],
        workplaceType: 'remote',
    });
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, provider: 'lever', region: 'eu' },
        'uk',
        deps(
            {},
            {
                fetch: async (input) => {
                    assert.equal(new URL(String(input)).hostname, 'api.eu.lever.co');
                    return Response.json([row]);
                },
            },
        ),
    );
    const job = result.jobs[0]!;
    assert.match(job.description!, /Requirements\nExperience with SQL/);
    assert.equal(job.salary, '£40,000 - 50,000 per year');
    assert.equal(job.jobType, 'Full-time');
    assert.equal(job.level, 'Junior');
    assert.match(job.location, /\| remote$/);
    assert.equal(job.listingSource?.postedAt, '2026-10-20T10:00:00.000Z');
});

test('pay without a structured interval never gets an invented annual unit', async () => {
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, provider: 'lever' },
        'uk',
        deps([lever({ salaryRange: { min: 20, max: 25, currency: 'GBP' } })]),
    );
    assert.equal(result.jobs[0]!.salary, '£20 - 25');
});

test('one-sided structured salary keeps its actual bound rather than inventing a fixed salary', async () => {
    const rows = [
        lever({ salaryRange: { min: 40000, currency: 'GBP', interval: 'year' } }),
        lever({
            salaryRange: { max: 50000, currency: 'GBP', interval: 'year' },
            hostedUrl: 'https://jobs.lever.co/actual-board/another-id',
        }),
    ];
    const result = await fetchEmployerBoardJobs({ ...BOARD, provider: 'lever' }, 'uk', deps(rows));
    assert.equal(result.jobs[0]!.salary, 'from £40,000 per year');
    assert.equal(result.jobs[1]!.salary, 'up to £50,000 per year');
});

test('impossible calendar dates and out-of-range timestamps exclude only their records', async () => {
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, provider: 'ashby' },
        'ireland',
        deps({
            jobs: [ashby({ publishedAt: '2026-02-30T10:00:00Z' }), ashby({ publishedAt: Number.MAX_VALUE }), ashby()],
        }),
    );
    assert.equal(result.jobs.length, 1);
    assert.equal(result.excluded, 2);
});

test('Ashby uses public posting API, includes compensation and preserves old still-listed roles', async () => {
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, provider: 'ashby' },
        'ireland',
        deps(
            {},
            {
                fetch: async (input) => {
                    assert.equal(
                        String(input),
                        'https://api.ashbyhq.com/posting-api/job-board/actual-board?includeCompensation=true',
                    );
                    return Response.json({ jobs: [ashby()] });
                },
            },
        ),
    );
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0]!.jobType, 'Full-time');
    assert.equal(result.jobs[0]!.level, 'Senior');
    assert.equal(result.jobs[0]!.listingSource?.postedAt, '2026-09-20T10:00:00.000Z');
});

test('a remote boolean without UK country evidence cannot make a global job British', async () => {
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, provider: 'ashby' },
        'uk',
        deps({ jobs: [ashby({ location: 'Remote', isRemote: true })] }),
    );
    assert.equal(result.jobs.length, 0);
    assert.equal(result.excluded, 1);
});

test('structured country proves UK remote eligibility without guessing a physical location', async () => {
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, provider: 'ashby' },
        'uk',
        deps({
            jobs: [
                ashby({
                    location: 'Remote',
                    address: { postalAddress: { addressCountry: 'GB' } },
                }),
            ],
        }),
    );
    assert.equal(result.jobs.length, 1);
});

test('country conflicts and ambiguous city names are excluded', async () => {
    const locations = [
        'London, Ontario, Canada',
        'Manchester, New Hampshire, USA',
        'Perth',
        'Cambridge',
        'Dublin, Ireland',
        'London, UK / Germany',
        'London, CA',
    ];
    const result = await fetchEmployerBoardJobs(
        BOARD,
        'uk',
        deps({
            jobs: locations.map((location) => greenhouse({ location: { name: location } })),
        }),
    );
    assert.equal(result.jobs.length, 0);
    assert.equal(result.excluded, locations.length);
});

test('clear UK city and Northern Ireland location are accepted while explicit other country wins', async () => {
    const rows = [
        greenhouse({
            location: { name: 'London' },
            absolute_url: 'https://job-boards.greenhouse.io/actual-board/jobs/1',
        }),
        greenhouse({
            location: { name: 'Belfast, Northern Ireland' },
            absolute_url: 'https://job-boards.greenhouse.io/actual-board/jobs/2',
        }),
        greenhouse({
            location: { name: 'London', country: 'CA' },
            absolute_url: 'https://job-boards.greenhouse.io/actual-board/jobs/3',
        }),
    ];
    const result = await fetchEmployerBoardJobs(BOARD, 'uk', deps({ jobs: rows }));
    assert.equal(result.jobs.length, 2);
    assert.equal(result.excluded, 1);
});

test('Irish named cities are accepted only for Irish requests', async () => {
    const payload = { jobs: [ashby({ location: 'Galway' })] };
    assert.equal(
        (await fetchEmployerBoardJobs({ ...BOARD, provider: 'ashby' }, 'ireland', deps(payload))).jobs.length,
        1,
    );
    assert.equal((await fetchEmployerBoardJobs({ ...BOARD, provider: 'ashby' }, 'uk', deps(payload))).jobs.length, 0);
});

test('missing titles, descriptions, locations and safe direct URLs cannot create cards', async () => {
    const result = await fetchEmployerBoardJobs(
        BOARD,
        'uk',
        deps({
            jobs: [
                greenhouse({ title: '' }),
                greenhouse({ content: 'Apply now' }),
                greenhouse({ location: null }),
                greenhouse({ absolute_url: 'javascript:alert(1)' }),
                greenhouse({ absolute_url: 'https://127.0.0.1/job' }),
                greenhouse({
                    absolute_url: 'https://user:secret@jobs.actualcompany.com/job',
                }),
            ],
        }),
    );
    assert.equal(result.jobs.length, 0);
    assert.equal(result.excluded, 6);
});

test('future, expired, malformed dates and explicitly hidden listings are excluded', async () => {
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, provider: 'ashby' },
        'ireland',
        deps({
            jobs: [
                ashby({ publishedAt: '2026-10-28T12:00:00Z' }),
                ashby({ validThrough: '2026-10-26T12:00:00Z' }),
                ashby({ publishedAt: 'yesterday' }),
                ashby({ validThrough: 'next week' }),
                ashby({ isListed: false }),
                ashby({ status: 'CLOSED' }),
                ashby({ isArchived: true }),
            ],
        }),
    );
    assert.equal(result.jobs.length, 0);
    assert.equal(result.excluded, 7);
});

test('omitted publication date remains absent and never becomes the check date', async () => {
    const result = await fetchEmployerBoardJobs(
        { ...BOARD, provider: 'lever' },
        'uk',
        deps([lever({ createdAt: undefined })]),
    );
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0]!.created_at, '');
    assert.equal(result.jobs[0]!.listingSource?.postedAt, undefined);
});

test('identical applications are deduplicated after tracking parameters are removed', async () => {
    const result = await fetchEmployerBoardJobs(
        BOARD,
        'uk',
        deps({
            jobs: [
                greenhouse(),
                greenhouse({
                    absolute_url: 'https://job-boards.greenhouse.io/actual-board/jobs/42?utm_source=indeed',
                }),
            ],
        }),
    );
    assert.equal(result.jobs.length, 1);
    assert.equal(result.examined, 2);
    assert.equal(result.excluded, 1);
});

test('board response scanning stops at 200 and reports partial coverage', async () => {
    const jobs = Array.from({ length: 205 }, (_, id) =>
        greenhouse({
            absolute_url: `https://job-boards.greenhouse.io/actual-board/jobs/${id}`,
        }),
    );
    const result = await fetchEmployerBoardJobs(BOARD, 'uk', deps({ jobs }));
    assert.equal(result.examined, 200);
    assert.equal(result.jobs.length, 200);
    assert.equal(result.limitReached, true);
});

test('an empty successfully retrieved board remains an empty successful observation', async () => {
    const result = await fetchEmployerBoardJobs(BOARD, 'uk', deps({ jobs: [] }));
    assert.deepEqual(result, {
        jobs: [],
        examined: 0,
        excluded: 0,
        retrievedAt: new Date(NOW).toISOString(),
        cacheHit: false,
        limitReached: false,
    });
});

test('licence evidence is inherited only from the exact supplied catalogue company', async () => {
    const company: PublicJobsPortalCompany = {
        id: 42,
        trading_name: 'Actual Analytics Limited',
        companies_house_name: null,
        url: 'https://actualanalytics.com',
        url_linkedin: null,
        url_favicon: null,
        description: '',
        estimated_num_employees_label: null,
        licensed_sponsor: true,
        ireland_permit_employer: false,
        cos_used_count_2025: null,
        open_to_sponsorship: null,
        show_recently_added_badge: false,
        added_to_register: null,
    };
    const result = await fetchEmployerBoardJobs({ ...BOARD, company }, 'uk', deps({ jobs: [greenhouse()] }));
    assert.equal(result.jobs[0]!.company_id, 42);
    assert.equal(result.jobs[0]!.company, company);
    assert.equal(result.jobs[0]!.listingSource?.employerLicence, 'catalogue-match');
    const unknown = await fetchEmployerBoardJobs(BOARD, 'uk', deps({ jobs: [greenhouse()] }));
    assert.equal(unknown.jobs[0]!.company?.licensed_sponsor, false);
    assert.equal(unknown.jobs[0]!.listingSource?.employerLicence, 'unknown');
});

test('source data cannot add guessed levels, arrangements or job types', async () => {
    const result = await fetchEmployerBoardJobs(BOARD, 'uk', deps({ jobs: [greenhouse({ title: 'Data Analyst' })] }));
    const job = result.jobs[0]!;
    assert.equal(job.level, undefined);
    assert.equal(job.jobType, undefined);
    assert.equal(job.location, 'London, United Kingdom');
});

test('large advertised and chunked response bodies are bounded', async () => {
    await assert.rejects(
        fetchEmployerBoardJobs(
            BOARD,
            'uk',
            deps(
                {},
                {
                    fetch: async () =>
                        new Response('{}', {
                            headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
                        }),
                },
            ),
        ),
        errorCode('TOO_LARGE'),
    );
    await assert.rejects(
        fetchEmployerBoardJobs(
            BOARD,
            'uk',
            deps({}, { fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }),
        ),
        errorCode('TOO_LARGE'),
    );
});

test('provider errors do not expose URL, response body or underlying credentials', async () => {
    for (const fetcher of [
        async () => new Response('secret-provider-body', { status: 403 }),
        async () => {
            throw new Error('secret-provider-key');
        },
    ]) {
        await assert.rejects(
            fetchEmployerBoardJobs(BOARD, 'uk', deps({}, { fetch: fetcher })),
            (error: unknown) => error instanceof EmployerSourceError && !/secret|http/.test(error.message),
        );
    }
});

test('a redirect response is never followed or accepted', async () => {
    let calls = 0;
    await assert.rejects(
        fetchEmployerBoardJobs(
            BOARD,
            'uk',
            deps(
                {},
                {
                    fetch: async () => {
                        calls++;
                        return new Response(null, {
                            status: 302,
                            headers: { Location: 'https://127.0.0.1/private' },
                        });
                    },
                },
            ),
        ),
        errorCode('UNAVAILABLE'),
    );
    assert.equal(calls, 1);
});

test('malformed provider payloads cannot become empty successful searches', async () => {
    await assert.rejects(
        fetchEmployerBoardJobs(BOARD, 'uk', deps({ jobs: 'not-an-array' })),
        errorCode('INVALID_RESPONSE'),
    );
    await assert.rejects(
        fetchEmployerBoardJobs(BOARD, 'uk', deps({}, { fetch: async () => new Response('<html>Captcha</html>') })),
        errorCode('INVALID_RESPONSE'),
    );
});

test('deadline is enforced even when an injected fetch ignores the abort signal', async () => {
    await assert.rejects(
        fetchEmployerBoardJobs(
            BOARD,
            'uk',
            deps(
                {},
                {
                    timeoutMs: 5,
                    fetch: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 25));
                        return Response.json({ jobs: [] });
                    },
                },
            ),
        ),
        errorCode('TIMEOUT'),
    );
});
