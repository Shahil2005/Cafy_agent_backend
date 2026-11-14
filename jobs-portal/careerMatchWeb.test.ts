import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
    careerWebReferenceSchema,
    collectCareerWebCandidates,
    reloadCareerWebCandidates,
    CareerWebError,
    type CareerWebReference,
} from './careerMatchWeb';
import { chatSearchSchema, type ChatSearch } from './chatIntent';
import { ChatExecutionError } from './chatExecution';
import { readChatEmployerBoard, type ChatLiveWebResult } from './chatLiveWeb';
import { searchChatGovernmentJobs } from './chatGovernmentSources';
import type { EmployerBoard, EmployerBoardResult } from './chatEmployerSources';
import type { JobsPortalJob } from './types';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const PATH = '/jobs/6adb5f1bfc1374228e9a6da4';
const SOURCE = `https://www.jobs.service.gov.uk${PATH}`;
const search = (fields: Partial<ChatSearch> = {}): ChatSearch =>
    chatSearchSchema.parse({ role: 'software', where: '', kind: 'career', ...fields });
function job(index = 1, fields: Partial<JobsPortalJob> = {}): JobsPortalJob {
    const url = `https://job-boards.greenhouse.io/fictional/jobs/${index}`;
    return {
        id: `web:${createHash('sha256').update(url).digest('hex')}`,
        title: 'Junior Software Developer', url, location: 'London, UK',
        description: 'Use TypeScript and React to build accessible software services. Collaborate with product teams and test reliable applications.',
        created_at: '', company_id: 42, level: 'Junior', jobType: 'Full-time',
        company: {
            id: 42, trading_name: 'Fictional Software Limited', companies_house_name: 'Fictional Software Limited',
            url: 'https://fictionalsoftware.co.uk/', url_linkedin: null, url_favicon: null,
            description: '', estimated_num_employees_label: null, licensed_sponsor: true,
            ireland_permit_employer: false, cos_used_count_2025: null, open_to_sponsorship: null,
            show_recently_added_badge: false, added_to_register: null,
        },
        listingSource: {
            kind: 'web', provider: 'employer-sites', publisher: 'Greenhouse',
            retrievedAt: new Date(NOW).toISOString(), availability: 'source-listed', employerLicence: 'catalogue-match',
        },
        ...fields,
    };
}
function board(fields: Partial<EmployerBoard> = {}): EmployerBoard {
    return { provider: 'greenhouse', token: 'fictional', region: 'global', company: job().company, ...fields };
}
function result(jobs: JobsPortalJob[] = [], fields: Partial<ChatLiveWebResult> = {}): ChatLiveWebResult {
    return {
        jobs, examined: jobs.length, excluded: 0, retrievedAt: new Date(NOW).toISOString(),
        cacheHit: false, boardsChecked: 1, boardsFailed: 0, boardsAvailable: 1, limitReached: false, ...fields,
    };
}
function boardResult(jobs: JobsPortalJob[]): EmployerBoardResult {
    return { ...result(jobs) };
}
function reference(index = 1, fields: Partial<Extract<CareerWebReference, { kind: 'employer-board' }>> = {}): CareerWebReference {
    return { kind: 'employer-board', provider: 'greenhouse', token: 'fictional', region: 'global', companyId: 42, url: job(index).url, ...fields };
}
function governmentJob(index = 1): JobsPortalJob {
    return job(index, {
        url: SOURCE, id: `web:${createHash('sha256').update(SOURCE).digest('hex')}`,
        listingSource: { ...job().listingSource!, publisher: 'GOV.UK Work Hub', employerLicence: 'unknown' },
    });
}

test('collects native employer and government adverts with references and original hard criteria', async () => {
    const first = job();
    const second = governmentJob();
    const found = await collectCareerWebCandidates(search({ levels: ['Junior'], where: 'London' }), 'uk', [], {
        now: () => NOW,
        employerSearch: async (criteria, country, deps) => {
            assert.equal(criteria.where, 'London');
            assert.deepEqual(criteria.levels, ['Junior']);
            assert.equal(country, 'uk');
            // A CV search reads twice the manual chat's employer boards.
            assert.equal(deps?.maxBoards, 12);
            deps?.onBoardJobs?.(board(), [first]);
            return result([first], { examined: 10 });
        },
        governmentSearch: async (_criteria, _country, deps) => {
            deps?.onJob?.(second, SOURCE);
            return result([second], { examined: 4 });
        },
    });
    assert.equal(found.jobs.length, 2);
    assert.equal(found.coverage.examined, 14);
    assert.equal(found.coverage.sourcesChecked, 2);
    assert.equal(found.coverage.sourcesFailed, 0);
    assert.equal(found.references[first.id]!.kind, 'employer-board');
    assert.deepEqual(found.references[second.id], { kind: 'government', sourcePath: PATH, url: SOURCE });
    assert.ok(Object.values(found.references).every((value) => careerWebReferenceSchema.safeParse(value).success));
    assert.equal(JSON.stringify(found.references).includes('description'), false);
});

test('an employer metadata outage preserves the independent government source', async () => {
    const found = await collectCareerWebCandidates(search(), 'uk', [], {
        now: () => NOW,
        employerSearch: async () => { throw new Error('private database detail must not escape'); },
        governmentSearch: async (_criteria, _country, deps) => {
            const advert = governmentJob(); deps?.onJob?.(advert, SOURCE); return result([advert]);
        },
    });
    assert.equal(found.jobs.length, 1);
    assert.equal(found.coverage.sourcesFailed, 1);
    assert.equal(found.coverage.limitReached, true);
    assert.equal(JSON.stringify(found).includes('private database'), false);
});

test('government outage preserves employer adverts without inventing completed coverage', async () => {
    const found = await collectCareerWebCandidates(search(), 'uk', [], {
        now: () => NOW,
        employerSearch: async (_criteria, _country, deps) => {
            deps?.onBoardJobs?.(board(), [job()]); return result([job()], { examined: 8 });
        },
        governmentSearch: async () => { throw new Error('source unavailable'); },
    });
    assert.equal(found.jobs.length, 1);
    assert.equal(found.coverage.examined, 8);
    assert.equal(found.coverage.sourcesFailed, 1);
});

test('all unavailable sources return explicit failed-source coverage, not a successful zero search', async () => {
    const found = await collectCareerWebCandidates(search(), 'uk', [], {
        employerSearch: async () => { throw new Error('outage'); },
        governmentSearch: async () => { throw new Error('outage'); },
    });
    assert.equal(found.jobs.length, 0);
    assert.equal(found.coverage.sourcesFailed, 2);
    assert.equal(found.coverage.sourcesChecked, 2);
});

test('expiry, dates, unsafe links, missing descriptions, missing employers and hard filter mismatches are excluded', async () => {
    const adverts = [
        job(1), job(2, { description: 'Short' }), job(3, { url: 'http://localhost/admin' }),
        job(4, { company: undefined }), job(5, { location: 'Manchester, UK' }),
        job(6, { level: 'Senior' }), job(7, { title: 'Payroll Assistant' }),
        job(8, { listingSource: { ...job().listingSource!, expiresAt: '2026-10-27T00:00:00Z' } }),
        job(9, { listingSource: { ...job().listingSource!, postedAt: '2030-01-01T00:00:00Z' } }),
        job(10, { listingSource: { ...job().listingSource!, expiresAt: 'unknown' } }),
    ];
    const found = await collectCareerWebCandidates(search({ where: 'London', levels: ['Junior'] }), 'ireland', [], {
        now: () => NOW,
        employerSearch: async (_criteria, _country, deps) => {
            deps?.onBoardJobs?.(board(), adverts); return result(adverts);
        },
    });
    assert.deepEqual(found.jobs.map((value) => value.id), [job().id]);
});

test('deduplicates canonical apply URLs across source observations and caps comparable candidates at 60', async () => {
    const adverts = Array.from({ length: 70 }, (_, index) => job(index));
    const duplicate = job(500, { url: `${job(1).url}?utm_source=google` });
    const found = await collectCareerWebCandidates(search(), 'ireland', [], {
        now: () => NOW,
        employerSearch: async (_criteria, _country, deps) => {
            deps?.onBoardJobs?.(board(), [...adverts, duplicate]); return result(adverts);
        },
    });
    assert.equal(found.jobs.length, 60);
    assert.equal(new Set(found.jobs.map((value) => value.url)).size, 60);
    assert.equal(Object.keys(found.references).length, 60);
    assert.equal(found.coverage.limitReached, true);
});

test('only one inferred role source round is used and original role alternatives remain filters-free', async () => {
    let calls = 0;
    const found = await collectCareerWebCandidates(search({ role: '' }), 'ireland', ['software', 'data analyst'], {
        now: () => NOW,
        employerSearch: async (criteria, _country, deps) => {
            calls++; assert.equal(criteria.role, 'software');
            const advert = job(2, { title: 'Data Analyst' });
            deps?.onBoardJobs?.(board(), [advert]); return result([advert]);
        },
    });
    assert.equal(calls, 1);
    assert.equal(found.jobs.length, 1);
    assert.equal(found.coverage.limitReached, true);
});

test('unsupported criteria, missing target and ineligible country/type do not browse arbitrary adverts', async () => {
    let calls = 0;
    const employerSearch = async () => { calls++; return result(); };
    for (const criteria of [search({ unsupported: ['commute time'] }), search({ role: '' }), search({ kind: 'part-time' })]) {
        const found = await collectCareerWebCandidates(criteria, 'ireland', [], { employerSearch });
        assert.equal(found.jobs.length, 0);
    }
    assert.equal(calls, 0);
});

test('Ireland uses employer adapters only and no cancellation is silently turned into empty results', async () => {
    let governmentCalls = 0;
    const found = await collectCareerWebCandidates(search(), 'ireland', [], {
        employerSearch: async () => result(),
        governmentSearch: async () => { governmentCalls++; return result(); },
    });
    assert.equal(governmentCalls, 0);
    assert.equal(found.coverage.sourcesChecked, 1);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(collectCareerWebCandidates(search(), 'uk', [], { signal: abort.signal }), ChatExecutionError);
});

test('a bounded round retains completed adverts when another source never completes', async () => {
    const found = await collectCareerWebCandidates(search(), 'uk', [], {
        now: () => NOW, timeoutMs: 15,
        employerSearch: async (_criteria, _country, deps) => {
            deps?.onBoardJobs?.(board(), [job()]); return result([job()]);
        },
        governmentSearch: () => new Promise(() => undefined),
    });
    assert.equal(found.jobs.length, 1);
    assert.equal(found.coverage.sourcesFailed, 1);
});

test('only callback-bound original source identities become candidates', async () => {
    const found = await collectCareerWebCandidates(search(), 'uk', [], {
        now: () => NOW,
        employerSearch: async () => result([job()]),
        governmentSearch: async (_criteria, _country, deps) => {
            deps?.onJob?.(governmentJob(), 'https://evil.co.uk/jobs/6adb5f1bfc1374228e9a6da4'); return result();
        },
    });
    assert.equal(found.jobs.length, 0);
});

test('reload reads an original board once, accepts exact retained URLs only and preserves cursor order', async () => {
    let reads = 0; let fetches = 0;
    const found = await reloadCareerWebCandidates([reference(2), reference(1)], search(), 'uk', {
        now: () => NOW,
        readBoard: async (id, country) => { reads++; assert.equal(id, 42); assert.equal(country, 'uk'); return board(); },
        fetchBoard: async (actual, country) => {
            fetches++; assert.equal(actual.token, 'fictional'); assert.equal(country, 'uk');
            return boardResult([job(1), job(2), job(3)]);
        },
    });
    assert.equal(reads, 1); assert.equal(fetches, 1);
    assert.deepEqual(found.jobs.map((value) => value.url), [job(2).url, job(1).url]);
    assert.equal(found.sourceFailures, 0);
});

test('changed board token, region, provider or employer identity never redirects a continuation', async () => {
    let fetches = 0;
    for (const changed of [board({ token: 'other' }), board({ region: 'eu' }), board({ provider: 'lever' }), board({ company: { ...job().company!, id: 99 } })]) {
        const found = await reloadCareerWebCandidates([reference()], search(), 'uk', {
            readBoard: async () => changed,
            fetchBoard: async () => { fetches++; return boardResult([job()]); },
        });
        assert.equal(found.jobs.length, 0);
    }
    assert.equal(fetches, 0);
});

test('fresh licence revocation and changed advert criteria are revalidated on continuation', async () => {
    const revoked = job(1, {
        company: { ...job().company!, licensed_sponsor: false },
        listingSource: { ...job().listingSource!, employerLicence: 'unknown' },
    });
    const found = await reloadCareerWebCandidates([reference()], search({ sponsorship: 'licensed-employer' }), 'uk', {
        now: () => NOW, readBoard: async () => board({ company: revoked.company }), fetchBoard: async () => boardResult([revoked]),
    });
    assert.equal(found.jobs.length, 0);
    const expired = job(1, { listingSource: { ...job().listingSource!, expiresAt: '2026-01-01T00:00:00Z' } });
    const ended = await reloadCareerWebCandidates([reference()], search(), 'uk', {
        now: () => NOW, readBoard: async () => board(), fetchBoard: async () => boardResult([expired]),
    });
    assert.equal(ended.jobs.length, 0);
});

test('one failed reload source preserves another source and sanitises failure detail', async () => {
    const refs = [reference(), reference(2, { companyId: 99, token: 'other' })];
    const found = await reloadCareerWebCandidates(refs, search(), 'uk', {
        now: () => NOW,
        readBoard: async (id) => { if (id === 99) throw new Error('private metadata'); return board(); },
        fetchBoard: async () => boardResult([job()]),
    });
    assert.equal(found.jobs.length, 1);
    assert.equal(found.sourceFailures, 1);
    assert.equal(JSON.stringify(found).includes('private'), false);
});

test('strict reference validation rejects arbitrary destinations, fields, duplicates and oversize before reads', async () => {
    let reads = 0;
    const invalid = [
        [{ ...reference(), token: '../private' }],
        [{ ...reference(), url: 'https://127.0.0.1/private' }],
        [{ ...reference(), url: 'https://attacker.co.uk/jobs/1', fetchUrl: 'https://attacker.co.uk/private' }],
        [reference(), reference()],
        Array.from({ length: 21 }, (_, index) => reference(index)),
    ];
    for (const refs of invalid) await assert.rejects(
        reloadCareerWebCandidates(refs as CareerWebReference[], search(), 'uk', {
            readBoard: async () => { reads++; return board(); },
        }),
        (error: unknown) => error instanceof CareerWebError && error.code === 'INVALID_REFERENCE',
    );
    assert.equal(reads, 0);
});

test('government continuation accepts exact Work Hub source paths and original apply identity only', async () => {
    const ref: CareerWebReference = { kind: 'government', sourcePath: PATH, url: SOURCE };
    let calls = 0;
    const found = await reloadCareerWebCandidates([ref], search(), 'uk', {
        now: () => NOW,
        governmentSearch: async (_criteria, _country, deps) => {
            calls++; assert.deepEqual(deps?.jobPaths, [PATH]);
            deps?.onJob?.(governmentJob(), SOURCE);
            deps?.onJob?.(job(2), SOURCE);
            return result([governmentJob(), job(2)]);
        },
    });
    assert.equal(calls, 1);
    assert.deepEqual(found.jobs.map((value) => value.url), [SOURCE]);
    await assert.rejects(reloadCareerWebCandidates([ref], search(), 'ireland'), CareerWebError);
});

test('government adapter exact reload performs GETs only to supplied fixed-host paths and no new search', async () => {
    const calls: string[] = [];
    let observed = '';
    const html = '<h1 data-testid="pageHeading">Junior Software Developer</h1><span data-testid="companyName">Fictional Digital</span><span data-testid="location">London, UK</span><div class="rawHtmlContainer"><p>Build TypeScript and React software services, improve accessibility, test reliable applications and collaborate with engineers.</p></div>';
    const found = await searchChatGovernmentJobs(search(), 'uk', {
        now: () => NOW, jobPaths: [PATH],
        fetch: async (input, init) => {
            calls.push(String(input)); assert.equal(init?.method, 'GET');
            assert.equal(init?.redirect, 'manual'); return new Response(html);
        },
        onJob: (_job, sourceUrl) => { observed = sourceUrl; },
    });
    assert.deepEqual(calls, [SOURCE]);
    assert.equal(observed, SOURCE);
    assert.equal(found.jobs.length, 1);
});

test('government exact reload rejects malformed, traversal and excessive paths without any fetch', async () => {
    let fetches = 0;
    for (const paths of [['https://attacker.co.uk/jobs/6adb5f1bfc1374228e9a6da4'], ['/jobs/../admin'], [PATH, PATH], Array(11).fill(PATH)])
        await assert.rejects(searchChatGovernmentJobs(search(), 'uk', {
            jobPaths: paths, fetch: async () => { fetches++; return new Response(''); },
        }));
    assert.equal(fetches, 0);
});

test('reload cancellation and unsupported filters never invoke source retrieval', async () => {
    let reads = 0;
    const abort = new AbortController(); abort.abort();
    await assert.rejects(reloadCareerWebCandidates([reference()], search(), 'uk', {
        signal: abort.signal, readBoard: async () => { reads++; return board(); },
    }), ChatExecutionError);
    const found = await reloadCareerWebCandidates([reference()], search({ unsupported: ['visa eligibility'] }), 'uk', {
        readBoard: async () => { reads++; return board(); },
    });
    assert.equal(reads, 0);
    assert.equal(found.jobs.length, 0);
});

test('part-time kind is a hard advert-type constraint on collection and continuation', async () => {
    const partTime = job(2, { jobType: 'Part-time' });
    const found = await collectCareerWebCandidates(search({ kind: 'part-time' }), 'uk', [], {
        now: () => NOW,
        employerSearch: async (_criteria, _country, deps) => {
            deps?.onBoardJobs?.(board(), [job(1), partTime]); return result([job(1), partTime]);
        },
        governmentSearch: async () => result(),
    });
    assert.deepEqual(found.jobs.map((value) => value.id), [partTime.id]);
    const reloaded = await reloadCareerWebCandidates([reference(1), reference(2)], search({ kind: 'part-time' }), 'uk', {
        now: () => NOW, readBoard: async () => board(), fetchBoard: async () => boardResult([job(1), partTime]),
    });
    assert.deepEqual(reloaded.jobs.map((value) => value.id), [partTime.id]);
});

test('real employer discovery and exact continuation metadata use only bounded SELECT builders', async () => {
    const reads: Array<{ relation: string; columns: string; ids?: unknown[] }> = [];
    const client = {
        from(relation: string) {
            const query = { relation, columns: '', ids: undefined as unknown[] | undefined };
            const builder = {
                select(columns: string) { query.columns = columns; return builder; },
                or() { return builder; },
                in(column: string, values: unknown[]) {
                    assert.equal(column, 'id'); query.ids = values; return builder;
                },
                order() { return builder; },
                limit(value: number) { assert.ok(value <= 201); return builder; },
                then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
                    reads.push({ ...query });
                    const data = relation === 'companies'
                        ? [{ ...job().company, ats_provider: 'greenhouse', ats_board_token: 'fictional' }]
                        : [{ company_id: 42 }];
                    return Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject);
                },
            };
            return builder;
        },
    } as unknown as SupabaseClient;
    const found = await collectCareerWebCandidates(search(), 'ireland', [], {
        now: () => NOW, client, fetchBoard: async () => boardResult([job()]),
    });
    assert.equal(found.jobs.length, 1);
    assert.equal(found.references[job().id]!.kind, 'employer-board');
    assert.equal(reads.length, 2);
    const reloaded = await readChatEmployerBoard(42, 'uk', { client });
    assert.equal(reloaded?.token, 'fictional');
    assert.equal(reloaded?.company?.id, 42);
    assert.equal(reads.length, 3);
    assert.equal(reads[2]!.relation, 'companies');
    assert.deepEqual(reads[2]!.ids, [42]);
    assert.ok(reads.every((value) => value.columns.length > 0));
    await assert.rejects(readChatEmployerBoard(0, 'uk', { client }));
    assert.equal(reads.length, 3);
});

test('web discovery spellings broaden retrieval only and preserve the original occupation on collection and reload', async () => {
    const adverts = [
        job(1, { title: 'Frontend Developer' }), job(2, { title: 'Front-end Developer' }),
        job(3, { title: 'Front End Developer' }), job(4, { title: 'React Developer' }),
        job(5, { title: 'Backend Developer', department: 'Frontend' }),
    ];
    const criteria = search({ role: 'frontend developer' });
    const found = await collectCareerWebCandidates(criteria, 'ireland', [], {
        now: () => NOW,
        employerSearch: async (query, _country, deps) => {
            assert.equal(query.role, 'front end developer');
            deps?.onBoardJobs?.(board(), adverts); return result(adverts);
        },
    });
    assert.deepEqual(found.jobs.map((value) => value.id), adverts.slice(0, 3).map((value) => value.id));
    const reloaded = await reloadCareerWebCandidates([reference(1), reference(2), reference(3), reference(4), reference(5)], criteria, 'uk', {
        now: () => NOW, readBoard: async () => board(), fetchBoard: async () => boardResult(adverts),
    });
    assert.deepEqual(reloaded.jobs.map((value) => value.id), adverts.slice(0, 3).map((value) => value.id));
});

test('a CV-inferred search keeps only adverts in the CV occupations instead of a whole employer board', async () => {
    const titles = ['Software Developer', 'Account Executive', 'Backend Engineer', 'Office Manager', 'Software Engineer II'];
    const adverts = titles.map((title, index) => job(index + 1, { title }));
    const found = await collectCareerWebCandidates(search({ role: '' }), 'ireland', ['Software Engineer', 'Backend Developer'], {
        now: () => NOW,
        employerSearch: async (_criteria, _country, deps) => { deps?.onBoardJobs?.(board(), adverts); return result(adverts); },
    });
    assert.deepEqual(found.jobs.map((advert) => advert.title), ['Software Developer', 'Backend Engineer', 'Software Engineer II']);
    // A role the student typed is still matched by the existing role filters, not narrowed to CV occupations.
    const typed = await collectCareerWebCandidates(search({ role: 'Account Executive' }), 'ireland', ['Software Engineer'], {
        now: () => NOW,
        employerSearch: async (_criteria, _country, deps) => { deps?.onBoardJobs?.(board(), adverts); return result(adverts); },
    });
    assert.ok(typed.jobs.some((advert) => advert.title === 'Account Executive'));
});
