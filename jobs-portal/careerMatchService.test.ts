import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatSearchSchema } from './chatIntent';
import { CareerCursorError, decryptCareerContext } from './careerMatchCursor';
import { ChatExecutionError } from './chatExecution';
import { careerMatchInputSchema, CareerMatchError, runCareerMatches, type CareerMatchContext, type CareerMatchDependencies } from './careerMatchService';
import type { CareerProfile } from './careerMatchTypes';
import type { JobsPortalJob } from './types';

const secret = 'test-only-career-cursor-secret-0123456789';
const clock = Date.parse('2026-10-28T12:00:00Z');
const profile: CareerProfile = {
    skills: [{ name: 'Python', evidence: 'Built Python reporting projects.' }, { name: 'SQL', evidence: 'Used SQL for financial reporting.' }],
    roles: [{ title: 'Software Engineer', evidence: 'Worked as a Software Engineer.' }],
};
const paid: CareerMatchContext = { userId: 'student-1', country: 'uk', careerPremium: true, partTimePremium: true, partTimeBlocked: false };
const resumeText = 'Worked as a Software Engineer. Built Python reporting projects. Used SQL for financial reporting. I also documented and tested my work.';
const start = () => careerMatchInputSchema.parse({ resumeText, includeWeb: false });
const job = (index: number): JobsPortalJob => ({
    id: `job-${String(index).padStart(2, '0')}`, title: 'Software Engineer', url: `https://careers.cafy.co.uk/adverts/${index}`,
    location: 'London', description: 'The role involves Python development and SQL reporting for internal systems. Strong communication is required.',
    created_at: '2026-10-27T00:00:00Z', company_id: 1,
});
function fixture(size = 15) {
    let extracts = 0; let collections = 0; let reloads = 0;
    const rows = Array.from({ length: size }, (_, index) => job(index));
    const deps: CareerMatchDependencies = {
        cursorSecret: secret, now: () => clock,
        webCollect: async () => ({ jobs: [], references: {}, coverage: { examined: 0, candidates: 0,
            sourcesChecked: 0, sourcesFailed: 0, sourcesAvailable: 2, limitReached: false } }),
        extract: async () => { extracts++; return profile; },
        collect: async (search, country, queries) => {
            collections++; assert.equal(country, 'uk'); assert.deepEqual(queries, search.role ? [search.role] : ['Software Engineer']);
            return { jobs: [...rows], coverage: { catalogueScanned: rows.length, candidates: rows.length, limitReached: false, sourceFailures: 0 } };
        },
        reload: async (ids) => { reloads++; return rows.filter((row) => ids.includes(row.id)); },
    };
    return { deps, rows, counts: () => ({ extracts, collections, reloads }) };
}

test('first request returns five evidence-backed cards with no internal score or resume text in continuation', async () => {
    const { deps } = fixture();
    const result = await runCareerMatches(start(), paid, deps);
    assert.deepEqual(result.jobs.map(({ job }) => job.id), ['job-00', 'job-01', 'job-02', 'job-03', 'job-04']);
    assert.equal(result.batchSize, 5); assert.equal(result.hasMore, true); assert.ok(result.nextCursor);
    assert.equal(result.state, 'results'); assert.ok(result.contextCursor);
    assert.ok(result.jobs.every((item) => item.evidence.length > 0 && !('score' in item)));
    assert.equal(result.nextCursor.includes(resumeText), false);
    assert.equal(result.nextCursor.includes('Software'), false);
    assert.equal('resumeText' in result, false);
});

test('next requests return exactly five unseen jobs from the fixed order without repeating AI or candidate search', async () => {
    const f = fixture();
    const first = await runCareerMatches(start(), paid, f.deps);
    const second = await runCareerMatches({ cursor: first.nextCursor! }, paid, f.deps);
    const third = await runCareerMatches({ cursor: second.nextCursor! }, paid, f.deps);
    assert.deepEqual(second.jobs.map(({ job }) => job.id), ['job-05', 'job-06', 'job-07', 'job-08', 'job-09']);
    assert.deepEqual(third.jobs.map(({ job }) => job.id), ['job-10', 'job-11', 'job-12', 'job-13', 'job-14']);
    assert.equal(new Set([...first.jobs, ...second.jobs, ...third.jobs].map(({ job }) => job.id)).size, 15);
    assert.equal(third.hasMore, false); assert.equal(third.nextCursor, undefined);
    assert.deepEqual(f.counts(), { extracts: 1, collections: 1, reloads: 2 });
});

test('a replay or concurrent retry is idempotent and has the same page identity', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps);
    const [left, right] = await Promise.all([
        runCareerMatches({ cursor: first.nextCursor! }, paid, f.deps),
        runCareerMatches({ cursor: first.nextCursor! }, paid, f.deps),
    ]);
    assert.deepEqual(left.jobs, right.jobs); assert.equal(left.pageId, right.pageId);
    assert.notEqual(first.pageId, left.pageId);
    assert.equal(f.counts().extracts, 1);
});

test('missing and changed adverts are skipped, filling the next five only from remaining ranked jobs', async () => {
    const f = fixture(18); const first = await runCareerMatches(start(), paid, f.deps);
    f.rows.splice(5, 2);
    f.rows.find((row) => row.id === 'job-07')!.description += ' Changed requirements.';
    const second = await runCareerMatches({ cursor: first.nextCursor! }, paid, f.deps);
    assert.deepEqual(second.jobs.map(({ job }) => job.id), ['job-08', 'job-09', 'job-10', 'job-11', 'job-12']);
    assert.equal(second.hasMore, true);
});

test('expiry, another user, country change and key rotation reject before any job reload or AI call', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps);
    const before = f.counts();
    for (const [context, deps] of [
        [{ ...paid, userId: 'other-student' }, f.deps],
        [{ ...paid, country: 'ireland' as const }, f.deps],
        [paid, { ...f.deps, cursorSecret: `${secret}-rotated` }],
        [paid, { ...f.deps, now: () => clock + 21 * 60_000 }],
    ] as const) {
        await assert.rejects(runCareerMatches({ cursor: first.nextCursor! }, context, deps), CareerCursorError);
    }
    assert.deepEqual(f.counts(), before);
});

test('expired entitlement and unsupported filters do not invoke the AI provider', async () => {
    const f = fixture();
    await assert.rejects(runCareerMatches(start(), { ...paid, careerPremium: false }, f.deps),
        (error: unknown) => error instanceof CareerMatchError && error.code === 'PLAN_REQUIRED');
    const unsupported = careerMatchInputSchema.parse({ resumeText, search: { role: 'software', where: '', kind: 'career', unsupported: ['specific working hours'] } });
    await assert.rejects(runCareerMatches(unsupported, paid, f.deps),
        (error: unknown) => error instanceof CareerMatchError && error.code === 'UNSUPPORTED_FILTERS');
    assert.deepEqual(f.counts(), { extracts: 0, collections: 0, reloads: 0 });
});

test('fewer than five supported adverts are returned without filler jobs or extra provider calls', async () => {
    const f = fixture(3); const result = await runCareerMatches(start(), paid, f.deps);
    assert.equal(result.jobs.length, 3); assert.equal(result.hasMore, false); assert.equal(result.nextCursor, undefined);
    assert.equal(f.counts().extracts, 1);
});

test('first-job CV without a role asks for a target role and does not browse unrelated jobs', async () => {
    const f = fixture();
    const result = await runCareerMatches(start(), paid, { ...f.deps, extract: async () => ({ ...profile, roles: [] }) });
    assert.equal(result.jobs.length, 0); assert.equal(result.hasMore, false);
    assert.equal(result.state, 'needs-role'); assert.ok(result.contextCursor);
    assert.match(result.message, /What kind of role should I hunt for/);
    assert.doesNotMatch(result.message, /end of|no matches|no further|exhausted/i);
    assert.equal(f.counts().collections, 0);
    assert.equal(result.profile.skills.length, 2);
});

test('an explicit target role works for CVs with no previous job title', async () => {
    const f = fixture();
    const input = careerMatchInputSchema.parse({ resumeText, search: { role: 'Software Engineer', where: 'London', kind: 'career' } });
    const result = await runCareerMatches(input, paid, { ...f.deps, extract: async () => ({ ...profile, roles: [] }) });
    assert.equal(result.jobs.length, 5); assert.equal(result.search.where, 'London');
    assert.match(result.jobs[0]!.reasons[0]!, /the role you asked for/);
});

test('a catalogue failure is distinct from an empty successful shortlist and private errors are not exposed', async () => {
    const f = fixture();
    const result = await runCareerMatches(start(), paid, { ...f.deps, collect: async () => ({
        jobs: [], coverage: { catalogueScanned: 0, candidates: 0, limitReached: false, sourceFailures: 1 },
    }) });
    assert.equal(result.state, 'unavailable'); assert.ok(result.contextCursor);
    assert.equal(result.hasMore, false); assert.equal(result.jobs.length, 0);
    assert.ok(result.coverage.sourceFailures > 0);
    assert.match(result.message, /couldn’t reach the job sources/);
});

test('the continuation cannot be mixed with a new CV, edited filters or user-controlled candidate IDs', () => {
    assert.equal(careerMatchInputSchema.safeParse({ cursor: 'x'.repeat(80), resumeText }).success, false);
    assert.equal(careerMatchInputSchema.safeParse({ cursor: 'x'.repeat(80), search: chatSearchSchema.parse({ role: 'doctor', where: '', kind: 'career' }) }).success, false);
    assert.equal(careerMatchInputSchema.safeParse({ resumeText, ids: ['job-01'] }).success, false);
    assert.equal(careerMatchInputSchema.safeParse({ resumeText: 'x'.repeat(40_001) }).success, false);
    for (const extra of [{ profile }, { resumeText }, { cursor: 'x'.repeat(80) }, { message: 'software' }])
        assert.equal(careerMatchInputSchema.safeParse({ contextCursor: 'x'.repeat(80), search: chatSearchSchema.parse({ role: '', where: '', kind: 'career' }), ...extra }).success, false);
    assert.equal(careerMatchInputSchema.safeParse({ contextCursor: 'x'.repeat(80) }).success, false);
    assert.equal(careerMatchInputSchema.safeParse({ contextCursor: 'x'.repeat(80), message: 'x'.repeat(2001) }).success, false);
});

test('cancellation before starting performs no extraction or catalogue work', async () => {
    const f = fixture();
    await assert.rejects(runCareerMatches(start(), paid, { ...f.deps, signal: AbortSignal.abort() }), CareerMatchError);
    assert.deepEqual(f.counts(), { extracts: 0, collections: 0, reloads: 0 });
});

test('inferred CV seniority is removed for retrieval while explicit student role filters remain intact', async () => {
    const f = fixture(); let queries: string[] = [];
    const deps: CareerMatchDependencies = { ...f.deps,
        extract: async () => ({ ...profile, roles: [{ title: 'Software Engineer Intern', evidence: 'Previously a Software Engineer Intern.' }] }),
        collect: async (_search, _country, roles) => {
            queries = roles;
            return { jobs: f.rows, coverage: { catalogueScanned: f.rows.length, candidates: f.rows.length, limitReached: false, sourceFailures: 0 } };
        },
    };
    await runCareerMatches(start(), paid, deps);
    assert.deepEqual(queries, ['Software Engineer']);
    await runCareerMatches(careerMatchInputSchema.parse({ resumeText,
        search: { role: 'Senior Software Engineer', where: '', kind: 'career' } }), paid, deps);
    assert.deepEqual(queries, ['Senior Software Engineer']);
});

test('page identity includes criteria even when a concurrent analysis finds identical IDs at the same clock time', async () => {
    const f = fixture();
    const all = await runCareerMatches(start(), paid, f.deps);
    const london = await runCareerMatches(careerMatchInputSchema.parse({ resumeText,
        search: { role: '', where: 'London', kind: 'career' } }), paid, f.deps);
    assert.notEqual(all.pageId, london.pageId);
});

const reportedProfile: CareerProfile = {
    skills: [
        { name: 'TypeScript', evidence: 'Used TypeScript and React.js to build accessible interface projects.' },
        { name: 'React.js', evidence: 'Used TypeScript and React.js to build accessible interface projects.' },
    ], roles: [],
};

function reportedFixture() {
    let extracts = 0; let collections = 0;
    const rows = Array.from({ length: 12 }, (_, index) => ({ ...job(index), title: 'Frontend Developer',
        description: 'Use TypeScript and React.js to build accessible interfaces for customers. Test and document the features.',
    }));
    const deps: CareerMatchDependencies = { cursorSecret: secret, now: () => clock,
        extract: async () => { extracts++; return reportedProfile; },
        collect: async (search, _country, queries) => {
            collections++; assert.deepEqual(queries, [search.role]);
            return { jobs: rows, coverage: { catalogueScanned: rows.length, candidates: rows.length, limitReached: false, sourceFailures: 0 } };
        },
        reload: async (ids) => rows.filter((row) => ids.includes(row.id)),
    };
    return { deps, rows, counts: () => ({ extracts, collections }) };
}

test('reported TypeScript and React.js CV without a role asks a question, then matches using the paid analysis once', async () => {
    const f = reportedFixture();
    const first = await runCareerMatches(start(), paid, f.deps);
    assert.equal(first.state, 'needs-role'); assert.equal(first.coverage.catalogueScanned, 0);
    assert.deepEqual(f.counts(), { extracts: 1, collections: 0 });
    const next = await runCareerMatches({ contextCursor: first.contextCursor,
        search: chatSearchSchema.parse({ role: 'frontend developer', where: 'London', kind: 'career' }),
    }, paid, f.deps);
    assert.equal(next.state, 'results'); assert.equal(next.jobs.length, 5);
    assert.deepEqual(f.counts(), { extracts: 1, collections: 1 });
    assert.deepEqual(next.profile, first.profile);
});

test('chat can collect location before the first role without re-extracting or querying unrelated jobs', async () => {
    const f = reportedFixture();
    const first = await runCareerMatches(start(), paid, f.deps);
    const location = await runCareerMatches({ contextCursor: first.contextCursor, message: 'in London' }, paid, f.deps);
    assert.equal(location.state, 'needs-role'); assert.equal(location.search.where, 'London');
    assert.deepEqual(f.counts(), { extracts: 1, collections: 0 });
    const role = await runCareerMatches({ contextCursor: location.contextCursor, message: 'frontend developer' }, paid, f.deps);
    assert.equal(role.state, 'results'); assert.equal(role.jobs.length, 5);
    assert.equal(role.search.where, 'London'); assert.equal(role.search.role, 'frontend developer');
    assert.deepEqual(f.counts(), { extracts: 1, collections: 1 });
});

test('an initial chat message applies the requested role and location in the same single-analysis request', async () => {
    const f = reportedFixture();
    const page = await runCareerMatches(careerMatchInputSchema.parse({ resumeText, message: 'frontend developer in London' }), paid, f.deps);
    assert.equal(page.state, 'results'); assert.equal(page.jobs.length, 5);
    assert.equal(page.search.role, 'frontend developer'); assert.equal(page.search.where, 'London');
    assert.deepEqual(f.counts(), { extracts: 1, collections: 1 });
});

test('generic extracted title words that strip to no occupation ask for a role without SQL', async () => {
    const f = fixture();
    const result = await runCareerMatches(start(), paid, { ...f.deps,
        extract: async () => ({ ...profile, roles: [{ title: 'Graduate Intern', evidence: 'Graduate Intern' }] }),
    });
    assert.equal(result.state, 'needs-role'); assert.equal(result.coverage.catalogueScanned, 0);
    assert.ok(result.contextCursor); assert.equal(f.counts().collections, 0);
});

test('a conversational next-five request uses the consumed context offset without repeating extraction or search', async () => {
    const f = fixture();
    const first = await runCareerMatches(start(), paid, f.deps);
    const second = await runCareerMatches({ contextCursor: first.contextCursor, message: 'next five' }, paid, f.deps);
    assert.deepEqual(second.jobs.map(({ job }) => job.id), ['job-05', 'job-06', 'job-07', 'job-08', 'job-09']);
    const third = await runCareerMatches({ contextCursor: second.contextCursor, message: 'more' }, paid, f.deps);
    assert.deepEqual(third.jobs.map(({ job }) => job.id), ['job-10', 'job-11', 'job-12', 'job-13', 'job-14']);
    const exhausted = await runCareerMatches({ contextCursor: third.contextCursor, message: 'more' }, paid, f.deps);
    assert.equal(exhausted.state, 'exhausted'); assert.equal(exhausted.jobs.length, 0);
    assert.ok(exhausted.contextCursor); assert.equal(exhausted.hasMore, false);
    assert.deepEqual(f.counts(), { extracts: 1, collections: 1, reloads: 2 });
});

test('role and location refinements after completion retain context and do not repeat CV extraction', async () => {
    const f = fixture(3);
    const first = await runCareerMatches(start(), paid, f.deps);
    assert.equal(first.state, 'results'); assert.equal(first.hasMore, false);
    const changed = await runCareerMatches({ contextCursor: first.contextCursor,
        search: chatSearchSchema.parse({ role: 'Software Engineer', where: 'London', kind: 'career' }),
    }, paid, f.deps);
    assert.equal(changed.state, 'results'); assert.equal(changed.jobs.length, 3);
    assert.deepEqual(f.counts(), { extracts: 1, collections: 2, reloads: 0 });
});

test('a successful empty search is no-matches rather than unavailable or exhausted and can be refined', async () => {
    const f = fixture(0);
    const first = await runCareerMatches(start(), paid, f.deps);
    assert.equal(first.state, 'no-matches'); assert.ok(first.contextCursor); assert.equal(first.coverage.sourceFailures, 0);
    const second = await runCareerMatches({ contextCursor: first.contextCursor, search: first.search }, paid, f.deps);
    assert.equal(second.state, 'no-matches'); assert.equal(f.counts().extracts, 1);
});

test('unavailable search retains the analysis and can retry with zero further paid extraction', async () => {
    const f = fixture(); let fail = true;
    const collect: NonNullable<CareerMatchDependencies['collect']> = async (...args) => {
        if (fail) { fail = false; throw new Error('PRIVATE_DATABASE_PROVIDER_SENTINEL'); }
        return f.deps.collect!(...args);
    };
    const first = await runCareerMatches(start(), paid, { ...f.deps, collect });
    assert.equal(first.state, 'unavailable'); assert.ok(first.contextCursor);
    assert.equal(first.coverage.sourceFailures, 1);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_DATABASE_PROVIDER/);
    const second = await runCareerMatches({ contextCursor: first.contextCursor, search: first.search }, paid, { ...f.deps, collect });
    assert.equal(second.state, 'results'); assert.equal(second.jobs.length, 5);
    assert.equal(f.counts().extracts, 1);
});

test('typed retry after the initial source outage reuses the same profile and criteria', async () => {
    const f = fixture(); let attempts = 0;
    const collect: NonNullable<CareerMatchDependencies['collect']> = async (...args) => {
        attempts++;
        if (attempts === 1) throw new Error('PRIVATE_TRANSIENT_OUTAGE');
        assert.equal(args[0].role, ''); assert.deepEqual(args[2], ['Software Engineer']);
        return f.deps.collect!(...args);
    };
    const first = await runCareerMatches(start(), paid, { ...f.deps, collect });
    const result = await runCareerMatches({ contextCursor: first.contextCursor, message: 'try again' }, paid, { ...f.deps, collect });
    assert.equal(result.state, 'results'); assert.equal(result.jobs.length, 5);
    assert.equal(result.search.role, ''); assert.equal(f.counts().extracts, 1);
    assert.equal(attempts, 2);
});

test('a failed next-page reload keeps the undelivered offset and retries without skipping jobs', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps);
    const failed = await runCareerMatches({ cursor: first.nextCursor! }, paid, { ...f.deps,
        reload: async () => { throw new Error('PRIVATE_RELOAD_FAILURE'); },
    });
    assert.equal(failed.state, 'unavailable'); assert.equal(failed.jobs.length, 0);
    const retry = await runCareerMatches({ contextCursor: failed.contextCursor, message: 'more' }, paid, f.deps);
    assert.deepEqual(retry.jobs.map(({ job }) => job.id), ['job-05', 'job-06', 'job-07', 'job-08', 'job-09']);
    assert.equal(f.counts().extracts, 1); assert.equal(f.counts().collections, 1);
});

test('typed retry after a next-page outage keeps the undelivered offset without another analysis or search', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps);
    const failed = await runCareerMatches({ contextCursor: first.contextCursor, message: 'next five' }, paid, { ...f.deps,
        reload: async () => { throw new Error('PRIVATE_NEXT_OUTAGE'); },
    });
    const retry = await runCareerMatches({ contextCursor: failed.contextCursor, message: 'please retry' }, paid, f.deps);
    assert.equal(retry.state, 'results');
    assert.deepEqual(retry.jobs.map(({ job }) => job.id), ['job-05', 'job-06', 'job-07', 'job-08', 'job-09']);
    assert.equal(new Set([...first.jobs, ...retry.jobs].map(({ job }) => job.id)).size, 10);
    assert.deepEqual(f.counts(), { extracts: 1, collections: 1, reloads: 1 });
});

test('retry without a source outage asks a clarification instead of treating retry as a role', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps);
    const clarified = await runCareerMatches({ contextCursor: first.contextCursor, message: 'retry' }, paid, f.deps);
    assert.equal(clarified.state, 'needs-clarification'); assert.deepEqual(clarified.search, first.search);
    assert.deepEqual(f.counts(), { extracts: 1, collections: 1, reloads: 0 });
    const noRole = reportedFixture(); const missing = await runCareerMatches(start(), paid, noRole.deps);
    const question = await runCareerMatches({ contextCursor: missing.contextCursor, message: 'try again' }, paid, noRole.deps);
    assert.equal(question.state, 'needs-role'); assert.equal(question.search.role, '');
    assert.deepEqual(noRole.counts(), { extracts: 1, collections: 0 });
});

test('context refinements cannot extend the original twenty-minute analysis lifetime', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps);
    const later = clock + 10 * 60_000;
    const second = await runCareerMatches({ contextCursor: first.contextCursor, search: first.search }, paid,
        { ...f.deps, now: () => later });
    const original = decryptCareerContext(first.contextCursor, paid.userId, paid.country, secret, clock);
    const refined = decryptCareerContext(second.contextCursor, paid.userId, paid.country, secret, later);
    assert.equal(refined.issuedAt, original.issuedAt); assert.equal(refined.expiresAt, original.expiresAt);
    await assert.rejects(runCareerMatches({ contextCursor: second.contextCursor, search: second.search }, paid,
        { ...f.deps, now: () => original.expiresAt }), CareerCursorError);
    assert.equal(f.counts().extracts, 1);
});

test('wrong user, country, key or tampered context fails before extraction or retrieval', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps); const before = f.counts();
    for (const [context, deps, cursor] of [
        [{ ...paid, userId: 'another-student' }, f.deps, first.contextCursor],
        [{ ...paid, country: 'ireland' as const }, f.deps, first.contextCursor],
        [paid, { ...f.deps, cursorSecret: `${secret}-rotation` }, first.contextCursor],
        [paid, f.deps, `${first.contextCursor.slice(0, -1)}!`],
        [paid, f.deps, first.nextCursor!],
    ] as const)
        await assert.rejects(runCareerMatches({ contextCursor: cursor, search: first.search }, context, deps), CareerCursorError);
    assert.deepEqual(f.counts(), before);
    await assert.rejects(runCareerMatches({ cursor: first.contextCursor }, paid, f.deps), CareerCursorError);
});

test('context refinements recheck entitlement, country and unsupported filters before reading jobs', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps); const before = f.counts();
    await assert.rejects(runCareerMatches({ contextCursor: first.contextCursor, search: first.search },
        { ...paid, careerPremium: false }, f.deps), (error: unknown) => error instanceof CareerMatchError && error.code === 'PLAN_REQUIRED');
    await assert.rejects(runCareerMatches({ contextCursor: first.contextCursor, search: { ...first.search, unsupported: ['commute time'] } },
        paid, f.deps), (error: unknown) => error instanceof CareerMatchError && error.code === 'UNSUPPORTED_FILTERS');
    assert.deepEqual(f.counts(), before);
});

test('ambiguity, unsupported exclusions and advice preserve the profile without unrelated queries', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps);
    for (const message of ['hello', 'not remote', 'how should I improve my CV?', 'what is the weather?']) {
        const result = await runCareerMatches({ contextCursor: first.contextCursor, message }, paid, f.deps);
        assert.equal(result.state, 'needs-clarification'); assert.equal(result.jobs.length, 0); assert.ok(result.contextCursor);
    }
    assert.deepEqual(f.counts(), { extracts: 1, collections: 1, reloads: 0 });
});

test('an interview advice question returns a routing flag once without repeating analysis or job queries', async () => {
    const f = fixture(); const first = await runCareerMatches(start(), paid, f.deps);
    const before = f.counts();
    const advice = await runCareerMatches({ contextCursor: first.contextCursor, message: 'Why am I not getting interviews?' }, paid, f.deps);
    assert.equal(advice.conversationAction, 'advice'); assert.equal(advice.state, 'needs-clarification');
    assert.equal(advice.message, 'Let’s work through that career question.');
    assert.deepEqual(advice.search, first.search); assert.deepEqual(f.counts(), before);
    assert.equal(advice.jobs.length, 0); assert.equal(advice.hasMore, false);
    const context = decryptCareerContext(advice.contextCursor, paid.userId, paid.country, secret, clock);
    const original = decryptCareerContext(first.contextCursor, paid.userId, paid.country, secret, clock);
    assert.equal(context.offset, original.offset); assert.deepEqual(context.entries, original.entries);
    const more = await runCareerMatches({ contextCursor: advice.contextCursor, message: 'next five' }, paid, f.deps);
    assert.equal(more.conversationAction, undefined);
    assert.deepEqual(more.jobs.map(({ job }) => job.id), ['job-05', 'job-06', 'job-07', 'job-08', 'job-09']);
});

test('advice remains available before a job title is selected without asking the same question again', async () => {
    const f = reportedFixture(); const first = await runCareerMatches(start(), paid, f.deps);
    const advice = await runCareerMatches({ contextCursor: first.contextCursor, message: 'Why am I not getting interviews?' }, paid, f.deps);
    assert.equal(advice.conversationAction, 'advice'); assert.equal(advice.state, 'needs-clarification');
    assert.equal(advice.search.role, ''); assert.deepEqual(f.counts(), { extracts: 1, collections: 0 });
});

test('cancellation and actual execution timeout are not relabelled as recoverable source failures', async () => {
    const f = fixture(); const controller = new AbortController();
    await assert.rejects(runCareerMatches(start(), paid, { ...f.deps, signal: controller.signal,
        extract: async () => { controller.abort(); return profile; },
    }), (error: unknown) => error instanceof CareerMatchError && error.code === 'CANCELLED');
    assert.equal(f.counts().collections, 0);
    await assert.rejects(runCareerMatches(start(), paid, { ...f.deps,
        collect: async () => { throw new ChatExecutionError('timeout'); },
    }), ChatExecutionError);
    const first = await runCareerMatches(start(), paid, f.deps);
    await assert.rejects(runCareerMatches({ contextCursor: first.contextCursor, search: first.search }, paid,
        { ...f.deps, signal: AbortSignal.abort() }), CareerMatchError);
});
