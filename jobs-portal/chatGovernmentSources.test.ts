import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    searchChatGovernmentJobs,
    GovernmentSourceError,
    type GovernmentSourceDependencies,
} from './chatGovernmentSources';
import { chatSearchSchema, type ChatSearch } from './chatIntent';
import { chatCivilServiceEvidence, matchChatJob } from './chatMatching';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const ID = '6adb5f1bfc1374228e9a6da4';
const ORIGIN = 'https://www.jobs.service.gov.uk';
const CSJ = 'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=2018673';
const APLI = 'https://www.aplitrak.com/?adid=YWN0dWFsX3B1YmxpY19qb2JfbGluaw';
const search = (fields: Partial<ChatSearch> = {}): ChatSearch =>
    chatSearchSchema.parse({ role: 'software', where: '', kind: 'career', ...fields });
function listing(ids: string[] = [ID], extra = ''): string {
    return `<form action="/jobs/search"><input data-testid="keywords-input" name="keywords"/></form>${ids.map((id) => `<a href="/jobs/${id}">Software engineer</a>`).join('')}${extra}`;
}
function detail(
    fields: Partial<Record<string, string>> = {},
    description = '<p>Build reliable software services with our engineering team and improve public services through careful delivery.</p>',
): string {
    const data = {
        pageHeading: 'Senior Software Developer',
        companyName: 'DWP Digital',
        salary: '£50,000 to £60,000 a year',
        jobPattern: 'Full-time',
        location: 'City Of Manchester, M2 3AA',
        remoteWorking: 'Hybrid - 2 days remote',
        jobType: 'Permanent',
        postingDate: '23 Oct 2026',
        closingDate: '13 Nov 2026',
        ...fields,
    };
    return `<main><h1 data-testid="pageHeading">${data.pageHeading}</h1><table>${Object.entries(data)
        .filter(([name]) => name !== 'pageHeading')
        .map(([name, value]) => `<tr><td data-testid="${name}">${value}</td></tr>`)
        .join('')}</table><h2>Summary</h2><div class="rawHtmlContainer">${description}</div></main>`;
}
function fixture(fields: Partial<GovernmentSourceDependencies> = {}): GovernmentSourceDependencies {
    return {
        now: () => NOW,
        fetch: async (input) => (String(input).includes('/search?') ? new Response(listing()) : new Response(detail())),
        ...fields,
    };
}

test('official rendered search and advert fields come from fixed-host GETs without a key', async () => {
    const calls: string[] = [];
    const result = await searchChatGovernmentJobs(
        search({ where: 'Manchester' }),
        'uk',
        fixture({
            fetch: async (input, init) => {
                const url = new URL(String(input));
                calls.push(url.href);
                assert.equal(url.origin, ORIGIN);
                assert.equal(init?.method, 'GET');
                assert.equal(init?.redirect, 'manual');
                assert.ok(init?.signal);
                assert.equal(new Headers(init?.headers).has('Authorization'), false);
                if (url.pathname === '/jobs/search') {
                    assert.equal(url.searchParams.get('keywords'), 'software');
                    assert.equal(url.searchParams.get('location'), 'Manchester');
                    assert.deepEqual(url.searchParams.getAll('jobBase'), ['REMOTE', 'ONSITE', 'HYBRID', 'FIELD_BASED']);
                    return new Response(listing());
                }
                return new Response(detail());
            },
        }),
    );
    assert.equal(calls.length, 2);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.examined, 1);
    const job = result.jobs[0]!;
    assert.equal(job.company!.trading_name, 'DWP Digital');
    assert.equal(job.company!.licensed_sponsor, false);
    assert.equal(job.company!.url, null);
    assert.equal(job.salary, '£50,000 to £60,000 a year');
    assert.equal(job.jobType, 'Full-time');
    assert.equal(job.level, 'Senior');
    assert.match(job.description!, /Build reliable software services/);
    assert.doesNotMatch(job.description!, /<p>/);
    assert.equal(job.listingSource!.postedAt, '2026-10-22T23:00:00.000Z');
    assert.equal(job.listingSource!.expiresAt, '2026-11-13T23:59:59.999Z');
    assert.equal(job.listingSource!.publisher, 'GOV.UK Work Hub');
    assert.equal(job.url, `${ORIGIN}/jobs/${ID}`);
    assert.equal(chatCivilServiceEvidence(job), undefined);
});

test('actual Work Hub to APLITRAK to CSJobs links establish source identity without fetching CSJobs', async () => {
    const calls: string[] = [];
    const scoped = search({ employerScope: 'civil-service' });
    const result = await searchChatGovernmentJobs(
        scoped,
        'uk',
        fixture({
            fetch: async (input) => {
                const url = new URL(String(input));
                calls.push(url.href);
                if (url.pathname === '/jobs/search') {
                    assert.equal(url.searchParams.get('includeAllKeywords'), 'civil service');
                    return new Response(listing());
                }
                if (url.hostname === 'www.aplitrak.com')
                    return new Response(`<html><a href="${CSJ}">Continue to Civil Service Jobs</a></html>`);
                if (url.pathname.endsWith('/before-you-apply'))
                    return new Response(`<a href="${APLI}">Continue to the employer&#x27;s website</a>`);
                return new Response(detail());
            },
        }),
    );
    assert.equal(calls.length, 4);
    assert.ok(calls.every((url) => !new URL(url).hostname.includes('civilservicejobs')));
    assert.equal(result.jobs[0]!.url, CSJ);
    assert.equal(matchChatJob(result.jobs[0]!, scoped).matches, true);
    assert.match(chatCivilServiceEvidence(result.jobs[0]!)!, /Civil Service Jobs/);
});

test('an actual direct CSJobs apply link needs no additional application-host fetch', async () => {
    let calls = 0;
    const result = await searchChatGovernmentJobs(
        search({ employerScope: 'civil-service' }),
        'uk',
        fixture({
            fetch: async (input) => {
                calls++;
                const path = new URL(String(input)).pathname;
                return new Response(
                    path === '/jobs/search'
                        ? listing()
                        : path.endsWith('/before-you-apply')
                          ? `<a href="${CSJ}">Continue to the employer's website</a>`
                          : detail(),
                );
            },
        }),
    );
    assert.equal(calls, 3);
    assert.equal(result.jobs[0]!.url, CSJ);
});

test('APLITRAK redirect targets are inspected but never followed', async () => {
    const result = await searchChatGovernmentJobs(
        search({ employerScope: 'civil-service' }),
        'uk',
        fixture({
            fetch: async (input) => {
                const url = new URL(String(input));
                if (url.hostname === 'www.aplitrak.com')
                    return new Response(null, { status: 302, headers: { location: CSJ } });
                return new Response(
                    url.pathname === '/jobs/search'
                        ? listing()
                        : url.pathname.endsWith('/before-you-apply')
                          ? `<a href="${APLI}">Continue to the employer's website</a>`
                          : detail(),
                );
            },
        }),
    );
    assert.equal(result.jobs[0]!.url, CSJ);
});

test('unknown external application hosts and lookalike ATS hosts are never fetched', async () => {
    for (const external of [
        'https://127.0.0.1/private',
        'https://www.aplitrak.com.evil.com/?adid=abc',
        'https://unknown-careers-site.com/apply',
    ]) {
        const calls: string[] = [];
        const result = await searchChatGovernmentJobs(
            search({ employerScope: 'civil-service' }),
            'uk',
            fixture({
                fetch: async (input) => {
                    const url = new URL(String(input));
                    calls.push(url.href);
                    assert.equal(url.origin, ORIGIN);
                    return new Response(
                        url.pathname === '/jobs/search'
                            ? listing()
                            : url.pathname.endsWith('/before-you-apply')
                              ? `<a href="${external}">Continue to the employer's website</a>`
                              : detail(),
                    );
                },
            }),
        );
        assert.equal(calls.length, 3);
        assert.equal(result.jobs[0]!.url, `${ORIGIN}/jobs/${ID}`);
        assert.equal(chatCivilServiceEvidence(result.jobs[0]!), undefined);
    }
});

test('blocked application provenance stays unknown without retries or identity guesses', async () => {
    let blockedCalls = 0;
    const result = await searchChatGovernmentJobs(
        search({ employerScope: 'civil-service' }),
        'uk',
        fixture({
            fetch: async (input) => {
                const url = new URL(String(input));
                if (url.hostname === 'www.aplitrak.com') {
                    blockedCalls++;
                    return new Response('Captcha', { status: 403 });
                }
                return new Response(
                    url.pathname === '/jobs/search'
                        ? listing()
                        : url.pathname.endsWith('/before-you-apply')
                          ? `<a href="${APLI}">Continue to the employer's website</a>`
                          : detail(),
                );
            },
        }),
    );
    assert.equal(blockedCalls, 1);
    assert.equal(result.limitReached, true);
    assert.equal(result.jobs[0]!.url, `${ORIGIN}/jobs/${ID}`);
});

test('expired jobs are excluded before extra provenance reads', async () => {
    let calls = 0;
    const result = await searchChatGovernmentJobs(
        search({ employerScope: 'civil-service' }),
        'uk',
        fixture({
            fetch: async (input) => {
                calls++;
                return new Response(
                    String(input).includes('/search?') ? listing() : detail({ closingDate: '26 Oct 2026' }),
                );
            },
        }),
    );
    assert.equal(calls, 2);
    assert.equal(result.jobs.length, 0);
    assert.equal(result.excluded, 1);
});

test('future or impossible dates and incomplete adverts are excluded', async () => {
    for (const fields of [
        { postingDate: '28 Oct 2026' },
        { postingDate: '30 Feb 2026' },
        { closingDate: 'tomorrow' },
        { pageHeading: '' },
        { companyName: '' },
        { location: '' },
    ]) {
        const result = await searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({
                fetch: async (input) => new Response(String(input).includes('/search?') ? listing() : detail(fields)),
            }),
        );
        assert.equal(result.jobs.length, 0);
        assert.equal(result.excluded, 1);
    }
});

test('unknown publication dates never become the checking timestamp', async () => {
    const result = await searchChatGovernmentJobs(
        search(),
        'uk',
        fixture({
            fetch: async (input) =>
                new Response(
                    String(input).includes('/search?') ? listing() : detail({ postingDate: '', closingDate: '' }),
                ),
        }),
    );
    assert.equal(result.jobs[0]!.created_at, '');
    assert.equal(result.jobs[0]!.listingSource!.postedAt, undefined);
});

test('summer publication and closing dates use the UK calendar rather than extending availability by an hour', async () => {
    const fields = { postingDate: '1 Jul 2026', closingDate: '2 Jul 2026' };
    const fetch: typeof globalThis.fetch = async (input) =>
        new Response(String(input).includes('/search?') ? listing() : detail(fields));
    const open = await searchChatGovernmentJobs(
        search(),
        'uk',
        fixture({ now: () => Date.parse('2026-07-01T12:00:00Z'), fetch }),
    );
    assert.equal(open.jobs[0]!.listingSource!.postedAt, '2026-06-30T23:00:00.000Z');
    assert.equal(open.jobs[0]!.listingSource!.expiresAt, '2026-07-02T22:59:59.999Z');
    const closed = await searchChatGovernmentJobs(
        search(),
        'uk',
        fixture({ now: () => Date.parse('2026-07-02T23:00:00Z'), fetch }),
    );
    assert.equal(closed.jobs.length, 0);
});

test('UK location evidence is required instead of treating every government-board advert as UK based', async () => {
    for (const location of [
        'Remote',
        'London, Ontario, Canada',
        'London, CA',
        'Dublin, Ireland',
        'Perth, Australia',
        'Singapore',
        'Cambridge, Massachusetts',
    ]) {
        const result = await searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({
                fetch: async (input) =>
                    new Response(String(input).includes('/search?') ? listing() : detail({ location })),
            }),
        );
        assert.equal(result.jobs.length, 0, location);
    }
    for (const location of ['Unknown town, SW1A 1AA', 'Dundee', 'London']) {
        const result = await searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({
                fetch: async (input) =>
                    new Response(String(input).includes('/search?') ? listing() : detail({ location })),
            }),
        );
        assert.equal(result.jobs.length, 1, location);
    }
});

test('nested advert markup becomes complete safe plain text', async () => {
    const body =
        '<div><p>Build software with real public-service teams.</p><div>Collaborate with researchers and designers to improve the service.</div></div><p>Review the final implementation.</p><script>unsafe()</script>';
    const result = await searchChatGovernmentJobs(
        search(),
        'uk',
        fixture({
            fetch: async (input) => new Response(String(input).includes('/search?') ? listing() : detail({}, body)),
        }),
    );
    assert.match(result.jobs[0]!.description!, /Review the final implementation/);
    assert.doesNotMatch(result.jobs[0]!.description!, /unsafe|<div>/);
});

test('ten-detail cap and concurrency three retain honest partial coverage', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(24, '0'));
    let active = 0;
    let maximum = 0;
    let details = 0;
    const result = await searchChatGovernmentJobs(
        search(),
        'uk',
        fixture({
            fetch: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === '/jobs/search')
                    return new Response(listing(ids, '<a href="/jobs/search?pageNumber=2">Next</a>'));
                details++;
                active++;
                maximum = Math.max(maximum, active);
                await new Promise((resolve) => setTimeout(resolve, 1));
                active--;
                return new Response(detail());
            },
        }),
    );
    assert.equal(result.jobs.length, 10);
    assert.equal(result.examined, 10);
    assert.equal(details, 10);
    assert.equal(maximum, 3);
    assert.equal(result.limitReached, true);
});

test('responsive duplicate links and identical actual CSJobs apply targets are deduplicated', async () => {
    const second = '6adb5f1acde5c8a238bef44a';
    const result = await searchChatGovernmentJobs(
        search({ employerScope: 'civil-service' }),
        'uk',
        fixture({
            fetch: async (input) => {
                const url = new URL(String(input));
                return new Response(
                    url.pathname === '/jobs/search'
                        ? listing([ID, ID, second])
                        : url.pathname.endsWith('/before-you-apply')
                          ? `<a href="${CSJ}">Continue to the employer's website</a>`
                          : detail(),
                );
            },
        }),
    );
    assert.equal(result.examined, 2);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.excluded, 1);
});

test('search and detail challenges are unavailable instead of a false successful zero', async () => {
    await assert.rejects(
        searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({ fetch: async () => new Response('<html>Verify you are human</html>') }),
        ),
        GovernmentSourceError,
    );
    await assert.rejects(
        searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({
                fetch: async (input) =>
                    new Response(String(input).includes('/search?') ? listing() : '<html>Verify you are human</html>'),
            }),
        ),
        GovernmentSourceError,
    );
});

test('external and malformed links cannot become detail requests', async () => {
    let calls = 0;
    const result = await searchChatGovernmentJobs(
        search(),
        'uk',
        fixture({
            fetch: async () => {
                calls++;
                return new Response(
                    listing(
                        [],
                        '<a href="https://evil.com/jobs/6adb5f1bfc1374228e9a6da4">Bad</a><a href="/jobs/not-an-id">Bad</a>',
                    ),
                );
            },
        }),
    );
    assert.equal(calls, 1);
    assert.equal(result.jobs.length, 0);
    assert.equal(result.examined, 0);
});

test('Ireland and unsupported constraints do not query this UK source', async () => {
    let calls = 0;
    const deps = fixture({
        fetch: async () => {
            calls++;
            throw new Error();
        },
    });
    assert.equal((await searchChatGovernmentJobs(search(), 'ireland', deps)).boardsAvailable, 0);
    assert.equal(
        (await searchChatGovernmentJobs(search({ unsupported: ['commute distance'] }), 'uk', deps)).boardsChecked,
        0,
    );
    assert.equal(calls, 0);
});

test('response size and caller cancellation are bounded', async () => {
    await assert.rejects(
        searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({ fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }),
        ),
        GovernmentSourceError,
    );
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
        searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({
                signal: controller.signal,
                fetch: async () => {
                    calls++;
                    return new Response(listing());
                },
            }),
        ),
        GovernmentSourceError,
    );
    assert.equal(calls, 0);
});

test('deadline bounds a fetch that ignores abort and errors omit raw payloads', async () => {
    await assert.rejects(
        searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({
                timeoutMs: 1,
                fetch: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    return new Response(listing());
                },
            }),
        ),
        GovernmentSourceError,
    );
    await assert.rejects(
        searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({
                fetch: async () => {
                    throw new Error('private transport credentials');
                },
            }),
        ),
        (error: unknown) => error instanceof GovernmentSourceError && !/private|credentials/.test(error.message),
    );
});

test('caller cancellation after one successful advert does not release partial results', async () => {
    const controller = new AbortController();
    const ids = [ID, '6adb5f1acde5c8a238bef44a'];
    await assert.rejects(
        searchChatGovernmentJobs(
            search(),
            'uk',
            fixture({
                signal: controller.signal,
                fetch: async (input) => {
                    const path = new URL(String(input)).pathname;
                    if (path === '/jobs/search') return new Response(listing(ids));
                    if (path.endsWith(ids[1]!)) {
                        await new Promise((resolve) => setTimeout(resolve, 2));
                        controller.abort();
                    }
                    return new Response(detail());
                },
            }),
        ),
        GovernmentSourceError,
    );
});
