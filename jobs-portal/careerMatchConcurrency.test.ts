import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CareerCursorError } from './careerMatchCursor';
import { runCareerMatches, type CareerMatchContext, type CareerMatchDependencies } from './careerMatchService';
import type { JobsPortalJob } from './types';

test('1,000 synthetic users keep independent five-job pagination without repeated analysis or shared session state', async () => {
    const rows: JobsPortalJob[] = Array.from({ length: 12 }, (_, index) => ({
        id: `job-${String(index).padStart(2, '0')}`, title: 'Software Engineer',
        url: `https://careers.cafy.co.uk/engineering/${index}`, location: 'London',
        description: 'Develop Python services and SQL reporting. Write tests and communicate project progress to the team.',
        created_at: '2026-10-28T00:00:00Z', company_id: 1,
    }));
    let extracts = 0; let collections = 0; let reloads = 0;
    const deps: CareerMatchDependencies = {
        cursorSecret: 'synthetic-isolation-secret-not-a-live-credential',
        now: () => Date.parse('2026-10-28T12:00:00Z'),
        extract: async () => {
            extracts++;
            return { skills: [{ name: 'Python', evidence: 'Developed Python services.' }, { name: 'SQL', evidence: 'Created SQL reporting.' }],
                roles: [{ title: 'Software Engineer', evidence: 'Worked as a Software Engineer.' }] };
        },
        collect: async () => {
            collections++;
            return { jobs: rows, coverage: { catalogueScanned: 12, candidates: 12, limitReached: false, sourceFailures: 0 } };
        },
        reload: async (ids) => { reloads++; return rows.filter((job) => ids.includes(job.id)); },
    };
    const context = (index: number): CareerMatchContext => ({ userId: `synthetic-student-${index}`,
        country: 'uk', careerPremium: true, partTimePremium: false, partTimeBlocked: false });
    const first = await Promise.all(Array.from({ length: 1000 }, (_, index) => runCareerMatches({
        resumeText: 'Worked as a Software Engineer. Developed Python services and created SQL reporting for team projects.',
    }, context(index), deps)));
    assert.equal(first.length, 1000);
    assert.equal(new Set(first.map((page) => page.pageId)).size, 1000);
    await assert.rejects(runCareerMatches({ cursor: first[0]!.nextCursor! }, context(1), deps), CareerCursorError);
    const second = await Promise.all(first.map((page, index) => runCareerMatches({ cursor: page.nextCursor! }, context(index), deps)));
    for (let index = 0; index < first.length; index++) {
        assert.equal(first[index]!.jobs.length, 5); assert.equal(second[index]!.jobs.length, 5);
        const ids = new Set(first[index]!.jobs.map(({ job }) => job.id));
        assert.ok(second[index]!.jobs.every(({ job }) => !ids.has(job.id)));
    }
    assert.equal(extracts, 1000); assert.equal(collections, 1000); assert.equal(reloads, 1000);
    // Every dependency above is in-memory. This is concurrency/isolation
    // coverage, not a provider, database or production capacity benchmark.
});
