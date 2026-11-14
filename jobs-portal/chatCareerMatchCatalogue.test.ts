import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { chatCatalogueReadBudgetMs, createChatCatalogueReadOnlyFetch, searchChatCatalogue } from './chatCatalogue';
import { collectCareerCandidates, reloadCareerCandidates } from './careerMatchCatalogue';
import { chatSearchSchema, type ChatSearch } from './chatIntent';

type Row = Record<string, unknown>;

const search = (overrides: Partial<ChatSearch> = {}): ChatSearch =>
    chatSearchSchema.parse({ role: '', where: '', kind: 'career', ...overrides });

function row(id: number | string, overrides: Row = {}): Row {
    return {
        id, company_id: 7, title: 'Software Developer', department: 'Software Engineering',
        location: 'Manchester, United Kingdom', url: `https://careers.cafy-fictional.com/jobs/${id}`,
        description: 'Build software with TypeScript and SQL. This is a fully remote role.',
        salary: 'GBP 45000 per year', job_type: 'Full-time', level: 'Junior',
        created_at: '2026-10-27T00:00:00Z', ...overrides,
    };
}

const company = {
    id: 7, trading_name: 'North Digital Limited', licensed_sponsor: true,
    url: 'https://careers.cafy-fictional.com',
};

/** Real Supabase query serialization over a fictional, in-memory GET-only transport. */
function fixture(tables: Record<string, Row[]>, fail?: (url: URL, call: number) => boolean) {
    const calls: Array<{ method: string; url: URL }> = [];
    const client = createClient('https://catalogue.cafy-fictional.com', 'fictional-test-key', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
            fetch: createChatCatalogueReadOnlyFetch({
                fetch: async (input, init) => {
                    const url = new URL(input instanceof Request ? input.url : String(input));
                    const method = init?.method || (input instanceof Request ? input.method : 'GET');
                    calls.push({ method, url });
                    assert.equal(method, 'GET');
                    if (fail?.(url, calls.length))
                        return new Response(JSON.stringify({ code: '500', message: 'Fictional unavailable source' }), {
                            status: 500, headers: { 'Content-Type': 'application/json' },
                        });
                    const table = url.pathname.split('/').pop()!;
                    let rows = tables[table] || [];
                    for (const [field, value] of url.searchParams) {
                        if (value.startsWith('in.(')) {
                            const values = value.slice(4, -1).split(',').map((item) => item.replace(/^"|"$/g, ''));
                            rows = rows.filter((candidate) => values.includes(String(candidate[field])));
                        }
                    }
                    const offset = Number(url.searchParams.get('offset') || 0);
                    const limit = Number(url.searchParams.get('limit') || rows.length);
                    return new Response(JSON.stringify(rows.slice(offset, offset + limit)), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Range': `${offset}-${Math.max(offset, offset + limit - 1)}/${rows.length}`,
                        },
                    });
                },
            }),
        },
    });
    return { client, calls };
}

test('CV candidate retrieval exceeds the ordinary ten-job page without changing legacy chat', async () => {
    const fake = fixture({ jobs: Array.from({ length: 80 }, (_, i) => row(i + 1)), companies: [company] });
    const ordinary = await searchChatCatalogue(search({ role: 'software' }), 'uk', 120, fake);
    assert.equal(ordinary.jobs.length, 10);
    const result = await collectCareerCandidates(search({ role: 'software' }), 'uk', [], fake);
    assert.equal(result.jobs.length, 80);
    assert.equal(result.coverage.catalogueScanned, 80);
    assert.equal(result.coverage.candidates, 80);
    assert.equal(result.coverage.limitReached, false);
    assert.equal(result.coverage.sourceFailures, 0);
    assert.match(fake.calls.find((call) => call.url.pathname.endsWith('/jobs'))!.url.searchParams.get('select')!, /description/);
});

test('candidate cap is 120 and coverage discloses a larger bounded catalogue', async () => {
    const fake = fixture({ jobs: Array.from({ length: 600 }, (_, i) => row(i + 1)), companies: [company] });
    const result = await collectCareerCandidates(search(), 'uk', ['software'], fake);
    assert.equal(result.jobs.length, 120);
    assert.equal(result.coverage.candidates, 120);
    assert.equal(result.coverage.catalogueScanned, 200);
    assert.equal(result.coverage.limitReached, true);
    assert.ok(fake.calls.every((call) => call.method === 'GET'));
});

test('dropping surplus matching rows from an exhausted batch still discloses the candidate limit', async () => {
    const fake = fixture({ jobs: Array.from({ length: 150 }, (_, i) => row(i + 1)), companies: [company] });
    const result = await collectCareerCandidates(search(), 'uk', ['software'], fake);
    assert.equal(result.jobs.length, 120);
    assert.equal(result.coverage.catalogueScanned, 150);
    assert.equal(result.coverage.limitReached, true);
});

test('at most six inferred role queries share a 1000-row scan budget and report omitted alternatives', async () => {
    const fake = fixture({ jobs: Array.from({ length: 1500 }, (_, i) => row(i + 1)), companies: [company] });
    const result = await collectCareerCandidates(search({ where: 'London' }), 'uk', [
        'software', 'data', 'finance', 'operations', 'marketing', 'design', 'sales', 'legal',
    ], fake);
    assert.equal(result.jobs.length, 0);
    assert.equal(result.coverage.catalogueScanned, 996);
    assert.equal(result.coverage.limitReached, true);
    assert.equal(fake.calls.filter((call) => call.url.pathname.endsWith('/jobs')).length, 12);
    const roles = new Set(fake.calls.flatMap((call) => call.url.searchParams.getAll('or'))
        .filter((value) => /title\.ilike/.test(value)));
    assert.equal(roles.size, 6);
});

test('explicit student occupation searches only its own title family', async () => {
    const fake = fixture({ jobs: [row(1), row(2, { title: 'Data Analyst', department: 'Data' })], companies: [company] });
    // For an explicit role the service passes the role's family, never CV-inferred directions.
    const result = await collectCareerCandidates(search({ role: 'software' }), 'uk', ['software'], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), ['1']);
    assert.equal(fake.calls.filter((call) => call.url.pathname.endsWith('/jobs')).length, 1);
});

test('an explicit generic role retrieves and keeps every equivalent title in its family', async () => {
    const fake = fixture({ jobs: [
        row('se', { title: 'Software Engineer', department: 'Platform' }),
        row('prog', { title: 'Programmer', department: 'Platform' }),
        row('data', { title: 'Data Analyst', department: 'Data' }),
    ], companies: [company] });
    const result = await collectCareerCandidates(search({ role: 'developer' }), 'uk',
        ['developer', 'Software Engineer', 'Programmer'], fake);
    assert.deepEqual(result.jobs.map((job) => job.id).sort(), ['prog', 'se']);
    const titles = fake.calls.flatMap((call) => call.url.searchParams.getAll('or')).join(' ');
    for (const token of ['developer', 'Software', 'Engineer', 'Programmer']) assert.match(titles, new RegExp(`title\\.ilike\\.%${token}%`, 'i'));
});

test('all student hard filters are rechecked before candidates enter the ranking pool', async () => {
    const good = row(1, {
        description: 'Use TypeScript and SQL. This is a fully remote role. Visa sponsorship is available.',
    });
    const rows = [
        good,
        row(2, { title: 'Data Analyst', department: 'Data' }),
        row(3, { location: 'London' }),
        row(4, { job_type: 'Internship' }),
        row(5, { level: 'Senior' }),
        row(6, { description: 'Use TypeScript. This is an on-site role. Visa sponsorship is available.' }),
        row(7, { salary: 'GBP 30000 per year' }),
        row(8, { description: 'Use TypeScript and SQL. This is a fully remote role. No visa sponsorship.' }),
        row(9, { company_id: 8, ...{ description: good.description } }),
    ];
    const fake = fixture({ jobs: rows, companies: [company, { ...company, id: 8, trading_name: 'Different Employer' }] });
    const result = await collectCareerCandidates(search({
        role: 'software', where: 'Manchester', employer: 'North', jobTypes: ['Full-time'], levels: ['Junior'],
        workingArrangement: 'remote', salary: { min: 40000, currency: 'GBP', period: 'year' },
        sponsorship: 'advert-confirmed',
    }), 'uk', [], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), ['1']);
});

test('institution scope still requires official Civil Service employer provenance', async () => {
    const fake = fixture({ jobs: [row(1), row(2, {
        url: 'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=1234567',
    })], companies: [company] });
    const result = await collectCareerCandidates(search({ employerScope: 'civil-service' }), 'uk', ['software'], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), ['2']);
});

test('multiple role retrievals deduplicate identities and tracking-only URL variants', async () => {
    const fake = fixture({ jobs: [
        row(1), row(2, { url: 'https://careers.cafy-fictional.com/jobs/1?utm_source=board' }),
    ], companies: [company] });
    const result = await collectCareerCandidates(search(), 'uk', ['software', 'developer', 'SOFTWARE'], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), ['1']);
    assert.equal(result.coverage.catalogueScanned, 4);
    assert.equal(result.coverage.candidates, 1);
});

test('missing descriptions, unsafe links and existing low-profile exclusions cannot become CV matches', async () => {
    const fake = fixture({ jobs: [
        row(1), row(2, { description: null }), row(3, { url: 'javascript:alert(1)' }),
        row(4, { title: 'Barista' }), row(5, { company_id: 999 }),
    ], companies: [company] });
    const result = await collectCareerCandidates(search(), 'uk', [], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), ['1']);
});

test('unusable descriptions and unsafe links do not fill the cap before later valid adverts', async () => {
    const invalid = Array.from({ length: 120 }, (_, index) => row(index + 1,
        index < 40 ? { description: null }
            : index < 80 ? { description: '<p>Apply now</p>' }
                : { url: 'javascript:alert(1)' },
    ));
    const valid = Array.from({ length: 12 }, (_, index) => row(index + 121));
    const fake = fixture({ jobs: [...invalid, ...valid], companies: [company] });
    const result = await collectCareerCandidates(search({ role: 'software' }), 'uk', [], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), valid.map((job) => String(job.id)));
    assert.equal(result.coverage.catalogueScanned, 132);
    assert.equal(result.coverage.candidates, 12);
    assert.equal(result.coverage.limitReached, false);
});

test('duplicate application URLs and repeated identities do not consume the candidate cap', async () => {
    const repeated = Array.from({ length: 150 }, (_, index) => row(index + 1, {
        url: `https://careers.cafy-fictional.com/jobs/repeated?utm_source=board${index}`,
    }));
    const valid = Array.from({ length: 20 }, (_, index) => row(index + 151));
    const fake = fixture({ jobs: [...repeated, ...valid], companies: [company] });
    const result = await collectCareerCandidates(search({ role: 'software' }), 'uk', [], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), ['1', ...valid.map((job) => String(job.id))]);
    assert.equal(result.coverage.catalogueScanned, 170);
    assert.equal(result.coverage.candidates, 21);
});

test('a later inferred-role query continues past adverts already selected by an earlier query', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => row(index + 1));
    const fake = fixture({ jobs: rows, companies: [company] });
    const result = await collectCareerCandidates(search(), 'uk', ['software', 'developer'], fake);
    assert.equal(result.jobs.length, 120);
    assert.equal(new Set(result.jobs.map((job) => job.id)).size, 120);
    assert.equal(result.jobs[result.jobs.length - 1]?.id, '120');
    assert.equal(result.coverage.catalogueScanned, 300);
    assert.equal(result.coverage.limitReached, true);
});

test('one failed query does not discard candidates from another alternative', async () => {
    const fake = fixture({ jobs: [row(1)], companies: [company] }, (url) =>
        url.pathname.endsWith('/jobs') && url.searchParams.getAll('or').some((value) => value.includes('%finance%')),
    );
    const result = await collectCareerCandidates(search(), 'uk', ['finance', 'software'], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), ['1']);
    assert.equal(result.coverage.sourceFailures, 1);
});

test('a later SELECT failure preserves only completed CV candidate batches with partial coverage', async () => {
    const fake = fixture({ jobs: Array.from({ length: 250 }, (_, index) => row(index + 1)), companies: [company] },
        (url) => url.pathname.endsWith('/jobs') && url.searchParams.get('offset') === '100',
    );
    const result = await collectCareerCandidates(search({ role: 'software' }), 'uk', [], fake);
    assert.equal(result.jobs.length, 100);
    assert.equal(result.jobs[99]!.id, '100');
    assert.deepEqual(result.coverage, { catalogueScanned: 100, candidates: 100, limitReached: true, sourceFailures: 1 });
});

test('a later employer hydration failure cannot discard earlier validated jobs or count unverified rows', async () => {
    let companyReads = 0;
    const fake = fixture({ jobs: Array.from({ length: 250 }, (_, index) => row(index + 1)), companies: [company] },
        (url) => url.pathname.endsWith('/companies') && ++companyReads === 2,
    );
    const result = await collectCareerCandidates(search({ role: 'software' }), 'uk', [], fake);
    assert.deepEqual(result.jobs.map((job) => job.id), Array.from({ length: 100 }, (_, index) => String(index + 1)));
    assert.deepEqual(result.coverage, { catalogueScanned: 100, candidates: 100, limitReached: true, sourceFailures: 1 });
    assert.equal(companyReads, 2);
});

test('a first SELECT or employer hydration failure remains unavailable with no fabricated candidate coverage', async () => {
    for (const table of ['jobs', 'companies']) {
        const fake = fixture({ jobs: [row(1)], companies: [company] }, (url) => url.pathname.endsWith(`/${table}`));
        const result = await collectCareerCandidates(search({ role: 'software' }), 'uk', [], fake);
        assert.deepEqual(result.jobs, []);
        assert.equal(result.coverage.catalogueScanned, 0);
        assert.equal(result.coverage.sourceFailures, 1);
    }
});

test('a caller cancellation after an eligible batch cannot publish partial CV results', async () => {
    const controller = new AbortController();
    const fake = fixture({ jobs: Array.from({ length: 250 }, (_, index) => row(index + 1)), companies: [company] }, (url) => {
        if (url.pathname.endsWith('/jobs') && url.searchParams.get('offset') === '100') {
            controller.abort();
            return true;
        }
        return false;
    });
    await assert.rejects(collectCareerCandidates(search({ role: 'software' }), 'uk', [], {
        ...fake, signal: controller.signal,
    }), /cancelled/);
});

test('ordinary manual chat retains unavailable behavior when a later batch fails', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => row(index + 1, {
        description: index < 5 ? 'This is a fully remote role involving TypeScript and SQL.' : 'This is an on-site role involving TypeScript and SQL.',
    }));
    const fake = fixture({ jobs: rows, companies: [company] },
        (url) => url.pathname.endsWith('/jobs') && url.searchParams.get('offset') === '100',
    );
    await assert.rejects(searchChatCatalogue(search({ role: 'software', workingArrangement: 'remote' }), 'uk', 10, fake), /search is unavailable/);
});

test('unsupported filters never touch a transport', async () => {
    const fake = fixture({});
    const result = await collectCareerCandidates(search({ unsupported: ['within ten minutes'] }), 'uk', ['software'], fake);
    assert.deepEqual(result.jobs, []);
    assert.equal(fake.calls.length, 0);
});

test('pre-aborted requests do not start a candidate SELECT', async () => {
    const fake = fixture({});
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(collectCareerCandidates(search(), 'uk', [], { ...fake, signal: controller.signal }), /cancelled/);
    await assert.rejects(reloadCareerCandidates(['1'], search(), 'uk', { ...fake, signal: controller.signal }), /cancelled/);
    assert.equal(fake.calls.length, 0);
});

test('country routing uses the Ireland catalogue and forbids Ireland part-time lookup', async () => {
    const fake = fixture({ jobs: [row(9)], jobs_IR: [row(1)], companies: [company] });
    const collected = await collectCareerCandidates(search(), 'ireland', [], fake);
    assert.deepEqual(collected.jobs.map((job) => job.id), ['1']);
    const reloaded = await reloadCareerCandidates(['1', '9'], search(), 'ireland', fake);
    assert.deepEqual(reloaded.map((job) => job.id), ['1']);
    assert.equal(fake.calls.some((call) => call.url.pathname.endsWith('/jobs')), false);
    const before = fake.calls.length;
    await assert.rejects(collectCareerCandidates(search({ kind: 'part-time' }), 'ireland', [], fake), /UK only/);
    await assert.rejects(reloadCareerCandidates(['1'], search({ kind: 'part-time' }), 'ireland', fake), /UK only/);
    assert.equal(fake.calls.length, before);
});

test('quality mode is respected during collection and later revalidation', async () => {
    const previous = process.env.UK_JOB_CATALOGUE_MODE;
    process.env.UK_JOB_CATALOGUE_MODE = 'quality';
    try {
        const fake = fixture({ quality_jobs: [row(1)], jobs: [row(9)], companies: [company] });
        const collected = await collectCareerCandidates(search(), 'uk', [], fake);
        const reloaded = await reloadCareerCandidates(['1'], search(), 'uk', fake);
        assert.deepEqual(collected.jobs.map((job) => job.id), ['1']);
        assert.deepEqual(reloaded.map((job) => job.id), ['1']);
        assert.equal(fake.calls.some((call) => call.url.pathname.endsWith('/jobs')), false);
    } finally {
        if (previous === undefined) delete process.env.UK_JOB_CATALOGUE_MODE;
        else process.env.UK_JOB_CATALOGUE_MODE = previous;
    }
});

test('reload preserves fixed ranking, skips deleted rows and reapplies changing hard criteria', async () => {
    const fake = fixture({ jobs: [row(1), row(2, { location: 'London' }), row(3)], companies: [company] });
    const result = await reloadCareerCandidates(['3', 'missing', '2', '1', '3'], search({ where: 'Manchester' }), 'uk', fake);
    assert.deepEqual(result.map((job) => job.id), ['3', '1']);
    const requests = fake.calls.filter((call) => call.url.pathname.endsWith('/jobs'));
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.url.searchParams.get('id')!, /^in\.\(/);
    assert.match(requests[0]!.url.searchParams.get('select')!, /description/);
    assert.equal(requests[0]!.url.searchParams.get('limit'), '4');
});

test('reload rejects unbounded or malformed identities before accessing any source', async () => {
    const fake = fixture({});
    for (const ids of [Array.from({ length: 121 }, () => '1'), [''], ['1,2'], ['../other'], ['a'.repeat(129)]])
        await assert.rejects(reloadCareerCandidates(ids, search(), 'uk', fake), /Invalid career candidate identities/);
    assert.deepEqual(await reloadCareerCandidates([], search(), 'uk', fake), []);
    assert.equal(fake.calls.length, 0);
});

test('refresh source errors remain unavailable rather than a successful missing-row result', async () => {
    const fake = fixture({}, () => true);
    await assert.rejects(reloadCareerCandidates(['1'], search(), 'uk', fake), /refresh is unavailable/);
});

test('shared candidate transport rejects every mutation method', async () => {
    let forwarded = 0;
    const transport = createChatCatalogueReadOnlyFetch({ fetch: async () => { forwarded++; return new Response('{}'); } });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
        await assert.rejects(transport('https://catalogue.cafy-fictional.com/rest/v1/jobs', { method }), /SELECT requests only/);
    assert.equal(forwarded, 0);
});

test('trusted CV read profile has a ten-second ceiling while ordinary chat remains capped at five', () => {
    assert.equal(chatCatalogueReadBudgetMs(), 5000);
    assert.equal(chatCatalogueReadBudgetMs({ timeoutMs: 20_000 }), 5000);
    assert.equal(chatCatalogueReadBudgetMs({ profile: 'career-matching' }), 10_000);
    assert.equal(chatCatalogueReadBudgetMs({ profile: 'career-matching', timeoutMs: 20_000 }), 10_000);
    assert.equal(chatCatalogueReadBudgetMs({ profile: 'career-matching', timeoutMs: 7000.9 }), 7000);
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(chatCatalogueReadBudgetMs({ timeoutMs }), 5000);
        assert.equal(chatCatalogueReadBudgetMs({ profile: 'career-matching', timeoutMs }), 10_000);
    }
    assert.equal(chatCatalogueReadBudgetMs({ profile: 'career-matching', timeoutMs: -1 }), 0);
    assert.equal(chatCatalogueReadBudgetMs({ profile: 'unrecognised' as never, timeoutMs: 20_000 }), 5000);
});

test('CV read profile still enforces a shorter explicit deadline without waiting ten seconds', async () => {
    let received: AbortSignal | null | undefined;
    const read = createChatCatalogueReadOnlyFetch({
        profile: 'career-matching', timeoutMs: 5,
        fetch: async (_input, init) => { received = init?.signal; return new Promise<Response>(() => undefined); },
    });
    await assert.rejects(read('https://catalogue.cafy-fictional.com/rest/v1/jobs'), /timed out/);
    assert.equal(received?.aborted, true);
});

test('CV read profile preserves caller cancellation and the SELECT-only method guard', async () => {
    const parent = new AbortController();
    let calls = 0;
    const read = createChatCatalogueReadOnlyFetch({
        profile: 'career-matching', signal: parent.signal,
        fetch: async () => { calls++; return new Promise<Response>(() => undefined); },
    });
    const pending = read('https://catalogue.cafy-fictional.com/rest/v1/jobs');
    parent.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(calls, 1);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
        await assert.rejects(read('https://catalogue.cafy-fictional.com/rest/v1/jobs', { method }), /SELECT requests only/);
    assert.equal(calls, 1);
});

test('CV read profile retains the eight-megabyte response body ceiling', async () => {
    const read = createChatCatalogueReadOnlyFetch({ profile: 'career-matching', fetch: async () =>
        new Response('{}', { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }),
    });
    await assert.rejects(read('https://catalogue.cafy-fictional.com/rest/v1/jobs'), /too large/);
});

test('career retrieval accepts joined, hyphenated and spaced frontend titles after a broad safe SQL prefilter', async () => {
    const fake = fixture({ jobs: [
        row(1, { title: 'Frontend Developer', department: 'Engineering' }),
        row(2, { title: 'Front-end Developer', department: 'Engineering' }),
        row(3, { title: 'Front End Developer', department: 'Engineering' }),
        row(4, { title: 'Front Office Developer', department: 'Engineering' }),
        row(5, { title: 'Backend Developer', department: 'Frontend Engineering' }),
    ], companies: [company] });
    const result = await collectCareerCandidates(search({ role: 'frontend developer' }), 'uk', [], fake);
    assert.deepEqual(result.jobs.map((value) => value.id), ['1', '2', '3']);
    const filters = fake.calls.find((call) => call.url.pathname.endsWith('/jobs'))!.url.searchParams.getAll('or');
    assert.deepEqual(filters, [
        '(title.ilike.%front%,department.ilike.%front%)',
        '(title.ilike.%end%,department.ilike.%end%)',
        '(title.ilike.%developer%,department.ilike.%developer%)',
    ]);
    const reloaded = await reloadCareerCandidates(['3', '2', '1', '4', '5'], search({ role: 'front-end developer' }), 'uk', fake);
    assert.deepEqual(reloaded.map((value) => value.id), ['3', '2', '1']);
});

test('career backend, fullstack and React spellings do not introduce unrelated occupation synonyms', async () => {
    for (const [requested, titles] of [
        ['backend developer', ['Backend Developer', 'Back-end Developer', 'Back End Developer']],
        ['fullstack engineer', ['Fullstack Engineer', 'Full-stack Engineer', 'Full Stack Engineer']],
        ['React.js developer', ['React.js Developer', 'ReactJS Developer', 'React Developer']],
    ] as const) {
        const fake = fixture({ jobs: [
            ...titles.map((title, index) => row(index + 1, { title, department: 'Engineering' })),
            row(9, { title: 'Payroll Administrator', department: requested }),
        ], companies: [company] });
        const result = await collectCareerCandidates(search({ role: requested }), 'uk', [], fake);
        assert.deepEqual(result.jobs.map((value) => value.id), ['1', '2', '3']);
        const roles = fake.calls.find((call) => call.url.pathname.endsWith('/jobs'))!.url.searchParams.getAll('or');
        assert.equal(roles.some((value) => /reactjs|react\.js|fullstack|backend/.test(value)), false);
    }
});

test('ordinary chat keeps its existing title/department role semantics without career spelling overrides', async () => {
    const fake = fixture({ jobs: [
        row(1, { title: 'Frontend Developer', department: 'Engineering' }),
        row(2, { title: 'Front-end Developer', department: 'Engineering' }),
    ], companies: [company] });
    const result = await searchChatCatalogue(search({ role: 'frontend developer' }), 'uk', undefined, fake);
    assert.deepEqual(result.jobs.map((value) => value.id), ['1']);
    const roles = fake.calls.find((call) => call.url.pathname.endsWith('/jobs'))!.url.searchParams.getAll('or');
    assert.deepEqual(roles, [
        '(title.ilike.%frontend%,department.ilike.%frontend%)',
        '(title.ilike.%developer%,department.ilike.%developer%)',
    ]);
});
