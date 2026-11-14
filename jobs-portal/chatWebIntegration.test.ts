import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { jobChatInputSchema } from './chatIntent';
import { runJobChat, type JobChatDependencies, type JobChatContext } from './chatService';
import { toPublicPortalJob, toPublicPortalJobs } from './publicResponse';
import { mergeChatJobSources, webRequestFromMessage } from './chatWebMerge';
import { enrichChatWebEmployers } from './chatWebCompanies';
import type { JobsPortalJob } from './types';
import type { SupabaseClient } from '@supabase/supabase-js';
const now = new Date().toISOString();
const paid: JobChatContext = {
    catalogCountry: 'uk',
    careerPremium: true,
    partTimePremium: true,
    partTimeBlocked: false,
};
const job = (index: number, web = false): JobsPortalJob =>
    toPublicPortalJob({
        id: web ? `web:${createHash('sha256').update(String(index)).digest('hex')}` : `db-${index}`,
        title: 'Data Analyst',
        location: 'London',
        company_id: web ? 0 : 4,
        url: `https://employer.example.com/jobs/${web ? 'web' : 'db'}-${index}`,
        description: `Analyse student outcomes and present trustworthy reporting to the team. Vacancy reference ${index} ${web ? 'web' : 'catalogue'}.`,
        company: {
            id: web ? 0 : 4,
            trading_name: 'Example Employer',
            url: 'https://employer.example.com',
            licensed_sponsor: false,
        },
        created_at: now,
        ...(web
            ? {
                  listingSource: {
                      kind: 'web',
                      provider: 'jsearch',
                      retrievedAt: now,
                      postedAt: now,
                      availability: 'unverified',
                      employerLicence: 'unknown',
                  },
              }
            : {}),
    });
const input = (message = 'Find data analyst jobs in London', includeWeb = true) =>
    jobChatInputSchema.parse({ message, includeWeb });
function deps(overrides: Partial<JobChatDependencies> = {}): JobChatDependencies {
    return {
        careerFeed: async () => ({ jobs: [job(1), job(2)], totalCount: 2, totalPages: 1, globalTotalCount: 2 }),
        partTimeFeed: async () => ({ jobs: [], totalCount: 0, totalPages: 1, globalTotalCount: 0 }),
        webFeed: async () => ({
            jobs: [job(3, true), job(4, true)],
            examined: 2,
            excluded: 0,
            retrievedAt: now,
            cacheHit: false,
        }),
        ...overrides,
    };
}

test('web requests are opt-in and disabled configuration keeps real catalogue results', async () => {
    let called = 0;
    const ordinary = await runJobChat(
        input(undefined, false),
        paid,
        deps({
            webFeed: async () => {
                called++;
                throw new Error();
            },
        }),
    );
    assert.equal(called, 0);
    assert.equal(ordinary.web?.status, 'not_requested');
    const result = await runJobChat(input(), paid, deps({ webFeed: undefined }));
    assert.equal(result.jobs.length, 2);
    assert.equal(result.web?.status, 'disabled');
    assert.match(result.message, /Web search is not enabled/);
});

test('free user cannot trigger a paid web request and retains the existing preview cap', async () => {
    let calls = 0;
    const result = await runJobChat(
        input(),
        { ...paid, careerPremium: false },
        deps({
            webFeed: async () => {
                calls++;
                throw new Error();
            },
        }),
    );
    assert.equal(calls, 0);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.web?.status, 'premium_required');
});

test('web and catalogue jobs merge before one shared cap with explicit provenance', async () => {
    const result = await runJobChat(
        input(),
        paid,
        deps({
            careerFeed: async () => ({
                jobs: Array.from({ length: 10 }, (_, index) => job(index)),
                totalCount: 30,
                totalPages: 3,
                globalTotalCount: 30,
            }),
            webFeed: async () => ({
                jobs: Array.from({ length: 10 }, (_, index) => job(index, true)),
                examined: 10,
                excluded: 0,
                retrievedAt: now,
                cacheHit: false,
            }),
        }),
    );
    assert.equal(result.jobs.length, 10);
    assert.equal(result.jobs.filter((value) => value.listingSource).length, 5);
    assert.equal(result.web?.returned, 5);
    assert.equal(result.web?.matched, 10);
    assert.match(result.message, /10 matching/);
    assert.equal(result.web?.exhaustive, false);
    assert.ok(result.message.length < 600);
    assert.ok(result.jobs.filter((value) => value.listingSource).every((value) => result.evidence[value.id]?.length));
});

test('unmatched web metadata cannot bypass the exact criteria matcher', async () => {
    const result = await runJobChat(input('Find data analyst jobs in London with at least £40k'), paid, deps());
    assert.equal(result.jobs.filter((value) => value.listingSource).length, 0);
    assert.equal(result.web?.matched, 0);
    assert.equal(result.web?.excluded, 2);
});

test('duplicate apply URLs prefer CAFY metadata and do not create extra listings', async () => {
    const db = job(1);
    const duplicate = { ...job(3, true), url: `${db.url}?utm_source=google_jobs` };
    const result = await runJobChat(
        input(),
        paid,
        deps({
            webFeed: async () => ({ jobs: [duplicate], examined: 1, excluded: 0, retrievedAt: now, cacheHit: false }),
        }),
    );
    assert.equal(result.jobs.length, 2);
    assert.equal(result.web?.matched, 1);
    assert.equal(result.web?.returned, 0);
    assert.equal(result.jobs[0]?.id, db.id);
});

test('identical adverts deduplicate while distinct job identity parameters survive', () => {
    const original = job(1);
    const duplicate = { ...original, id: 'other', url: 'https://another.example/same-ad' };
    assert.equal(mergeChatJobSources([original], [duplicate]).length, 1);
    const different = { ...job(2, true), url: 'https://employer.example.com/apply?jobId=2' };
    const another = { ...job(3, true), url: 'https://employer.example.com/apply?jobId=3' };
    assert.equal(mergeChatJobSources([], [different, another]).length, 2);
});

test('provider failure keeps catalogue jobs and reports unavailable rather than zero web matches', async () => {
    const result = await runJobChat(
        input(),
        paid,
        deps({
            webFeed: async () => {
                throw new Error('Do not expose provider errors');
            },
        }),
    );
    assert.equal(result.jobs.length, 2);
    assert.equal(result.web?.status, 'unavailable');
    assert.match(result.message, /can’t rule out further matches/);
    assert.doesNotMatch(result.message, /Do not expose provider/);
});

test('unsupported criteria and country conflicts never incur web calls', async () => {
    let called = 0;
    for (const message of ['Find jobs within 10 miles of London', 'Find jobs in Ireland']) {
        const result = await runJobChat(
            input(message),
            paid,
            deps({
                webFeed: async () => {
                    called++;
                    throw new Error();
                },
            }),
        );
        assert.equal(result.jobs.length, 0);
        assert.equal(result.web?.status, 'skipped');
    }
    assert.equal(called, 0);
});

test('natural web source requests do not corrupt role keywords or web developer occupations', () => {
    assert.deepEqual(webRequestFromMessage('Find web developer jobs from the web as well'), {
        message: 'Find web developer jobs',
        requested: true,
    });
    assert.deepEqual(webRequestFromMessage('Search web developer jobs in London'), {
        message: 'Search web developer jobs in London',
        requested: false,
    });
    assert.deepEqual(webRequestFromMessage('Search the web for analyst jobs'), {
        message: 'for analyst jobs',
        requested: true,
    });
});

test('natural request uses web while preserving a real role and location', async () => {
    const result = await runJobChat(
        input('Find data analyst jobs in London from the web as well', false),
        paid,
        deps(),
    );
    assert.equal(result.web?.status, 'searched');
    assert.equal(result.search.role, 'data analyst');
    assert.equal(result.search.where, 'London');
});

test('malformed provenance cannot silently turn a web record into a catalogue card', () => {
    const bad = { ...job(1, true), listingSource: { kind: 'web', provider: 'invented' } };
    assert.equal(toPublicPortalJobs([bad]).length, 0);
    assert.equal(
        toPublicPortalJobs([
            { ...job(1, true), listingSource: { ...job(1, true).listingSource, employerLicence: ['unknown'] } },
        ]).length,
        0,
    );
});

function companyDb(rows: Record<string, unknown>[], error: unknown = null): SupabaseClient {
    return {
        from: () => ({ select: () => ({ or: () => ({ limit: async () => ({ data: rows, error }) }) }) }),
    } as unknown as SupabaseClient;
}
const record = {
    id: 44,
    trading_name: 'Example Employer',
    url: 'https://employer.example.com',
    licensed_sponsor: true,
};
test('licence enrichment requires a unique exact name AND website identity', async () => {
    const [matched] = await enrichChatWebEmployers([job(1, true)], companyDb([record]));
    assert.equal(matched?.company?.licensed_sponsor, true);
    assert.equal(matched?.listingSource?.employerLicence, 'catalogue-match');
    for (const rows of [
        [{ ...record, url: 'https://unrelated.example' }],
        [record, { ...record, id: 45 }],
        [{ ...record, licensed_sponsor: false }],
    ]) {
        const [unknown] = await enrichChatWebEmployers([job(1, true)], companyDb(rows));
        assert.equal(unknown?.listingSource?.employerLicence, 'unknown');
        assert.equal(unknown?.company?.licensed_sponsor, false);
    }
});

test('licence data failure is not converted into a verified or unlicensed employer claim', async () => {
    await assert.rejects(
        enrichChatWebEmployers([job(1, true)], companyDb([], { message: 'unavailable', code: '503' })),
        /Employer evidence is unavailable/,
    );
});

test('positive advert wording without catalogue employer identity cannot satisfy sponsorship', async () => {
    const unverified = {
        ...job(1, true),
        description: 'We offer visa sponsorship for this role. Work on data analysis with a supportive team.',
        company: { ...job(1, true).company!, licensed_sponsor: true },
    };
    const result = await runJobChat(
        input('Find data analyst jobs in London with visa sponsorship'),
        paid,
        deps({
            webFeed: async () => ({ jobs: [unverified], examined: 1, excluded: 0, retrievedAt: now, cacheHit: false }),
        }),
    );
    assert.equal(result.web?.matched, 0);
});
