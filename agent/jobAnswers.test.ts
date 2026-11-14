import { test } from 'node:test';
import assert from 'node:assert/strict';
import { honestSummary, jobVerdict, searchJobs, type JobDetail, type JobSearchDeps, type RankRequest } from './jobs/search';
import { askedJobCount, createJobTools } from './tools/jobs';
import type { AgentBlock, JobListCard } from './contract';

test('one matching skill and no gaps is not described as "0 gaps to check"', () => {
    const verdict = jobVerdict({ have: 1, missing: 0, years: 2 });
    assert.equal(verdict.label, 'possible');
    assert.doesNotMatch(verdict.reason, /\b0 gaps\b/);
    assert.match(verdict.reason, /one thing/i);
});

test('a summary may not claim more than the verdict', () => {
    assert.equal(honestSummary('This internship is a strong fit given your graduation date.', 'stretch'), undefined);
    assert.equal(honestSummary('This role could be a good fit for you, as you have strong problem-solving skills.', 'stretch'), undefined);
    assert.equal(honestSummary('A strong opportunity to contribute high-quality code.', 'possible'), undefined);
    assert.equal(honestSummary('A perfect match for your Java and SQL work.', 'close'), undefined);
    assert.equal(honestSummary('This role could be a good fit as you have built Tableau dashboards.', 'close'), 'This role could be a good fit as you have built Tableau dashboards.');
    assert.equal(honestSummary('The advert asks for Power BI, which your CV does not show.', 'stretch'), 'The advert asks for Power BI, which your CV does not show.');
});

const cv = { version: 5, name: 'CV.pdf', hash: 'h', createdAt: 0, expiresAt: 0, text: 'Built SQL pipelines.', profile: { headline: 'Data analyst', roles: [{ title: 'Data Analyst', type: 'job', start: '2022', end: '2025', evidence: 'x' }], education: [], skills: [{ name: 'SQL', source: 'experience', evidence: 'x' }], projects: [], achievements: [], certifications: [], languages: [], hasPersonalStatement: false }, chunks: [{ index: 0, section: 'Experience', text: 'Built SQL pipelines.', embedding: [0.1, 0.2] }] } as never;
const signal = new AbortController().signal;

function deps(total = 50): JobSearchDeps & { requests: RankRequest[] } {
    const requests: RankRequest[] = [];
    return {
        requests,
        rank: async (request) => {
            requests.push(request);
            const excluded = new Set((request.filters.exclude_job_ids as number[] | undefined) ?? []);
            return Array.from({ length: total }, (_, i) => i + 1).filter((id) => !excluded.has(id)).slice(0, request.limit).map((job_id) => ({ job_id, meaning: 0.9 - job_id / 1000, keyword: 0, seniority: null }));
        },
        details: async (ids) => ids.map((id): JobDetail => ({ id, title: `Data Role ${id}`, company: `Co ${id}`, sponsor: false })),
        companyIds: async () => [],
        embed: async () => [0.3, 0.4],
        explain: async () => [],
    };
}

test('"more" reuses the first ranking (same request, so it is cached) and skips the jobs already shown', async () => {
    const d = deps(50);
    const outcome = await searchJobs({ role: 'data' }, { cv, years: 2, signal, excludeJobIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, d);
    assert.equal(d.requests.length, 1, 'one ranking');
    assert.equal(d.requests[0]!.filters.exclude_job_ids, undefined, 'the same request as the first search');
    assert.ok(outcome.status === 'ok');
    assert.deepEqual(outcome.card.items.map((j) => j.id).sort((a, b) => a - b), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test('"more" past the first ranking asks the database for the rest', async () => {
    const d = deps(80);
    const shown = Array.from({ length: 45 }, (_, i) => i + 1);
    const outcome = await searchJobs({ role: 'data' }, { cv, years: 2, signal, excludeJobIds: shown }, d);
    assert.equal(d.requests.length, 2);
    assert.deepEqual(d.requests[1]!.filters.exclude_job_ids, shown);
    assert.ok(outcome.status === 'ok' && outcome.card.items.every((j) => j.id > 45));
});

test('"more" with fewer matches than the first ranking returned ends cleanly', async () => {
    const d = deps(12);
    const outcome = await searchJobs({ role: 'data' }, { cv, years: 2, signal, excludeJobIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, d);
    assert.equal(d.requests.length, 1, 'the first ranking already held every match');
    assert.ok(outcome.status === 'ok');
    assert.deepEqual(outcome.card.items.map((j) => j.id).sort((a, b) => a - b), [11, 12]);
});

test('the number of jobs asked for is read from the message', () => {
    assert.equal(askedJobCount('Give me 20 most suitable jobs for my resume'), 20);
    assert.equal(askedJobCount('show me ten more jobs'), 10);
    assert.equal(askedJobCount('jobs paying over 30000'), undefined);
    assert.equal(askedJobCount('jobs posted in the last 7 days'), undefined);
    assert.equal(askedJobCount('give me jobs for my cv'), undefined);
});

function ctxFor(message: string, lastJobs?: JobListCard) {
    const blocks: AgentBlock[] = [];
    return { blocks, ctx: { uid: 'u', signal, cv, userMessage: message, ...(lastJobs ? { lastJobs, jobLists: [lastJobs] } : {}), emit: (_id: string, b: AgentBlock) => { blocks.push(b); } } as never };
}

test('asking for more jobs than the list holds shows the next jobs, and says jobs come 10 at a time', async () => {
    const d = deps(50);
    const tools = createJobTools(d);
    const search = tools.find((t) => t.name === 'search_jobs')!;
    const first = ctxFor('data jobs');
    await search.run({ role: 'data' }, first.ctx);
    const list = (first.blocks.find((b) => b.kind === 'jobList') as Extract<AgentBlock, { kind: 'jobList' }>).card;
    const recommend = tools.find((t) => t.name === 'recommend_jobs')!;
    const out = (await recommend.run({ count: 10 }, ctxFor('Give me 20 most suitable jobs for my resume', list).ctx)) as { instruction: string; jobs: Array<{ position: number }> };
    assert.match(out.instruction, /10 at a time/);
    assert.equal(d.requests.length, 2);
    assert.ok(out.jobs.length === 10);
});

test('a search asked for more than 10 says jobs come 10 at a time', async () => {
    const search = createJobTools(deps(50)).find((t) => t.name === 'search_jobs')!;
    const out = (await search.run({ role: 'data' }, ctxFor('show me 25 data jobs').ctx)) as { instruction: string };
    assert.match(out.instruction, /10 at a time/);
});

test('the model may pass count 20: the full page shows, with the "10 at a time" note, never an error', async () => {
    const search = createJobTools(deps(50)).find((t) => t.name === 'search_jobs')!;
    assert.ok(search.args.safeParse({ count: 20 }).success, 'count 20 is valid');
    const { blocks, ctx } = ctxFor('the most suitable ones please');
    const out = (await search.run(search.args.parse({ role: 'data', count: 20 }), ctx)) as { instruction: string; count: number };
    assert.equal(out.count, 10);
    assert.match(out.instruction, /10 at a time/);
    assert.ok(blocks.some((b) => b.kind === 'jobList' && !b.card.pick), 'the list, not a short pick');
});

test('"20 jobs" again for the search on screen shows the next 10, not the same 10', async () => {
    const d = deps(50);
    const search = createJobTools(d).find((t) => t.name === 'search_jobs')!;
    const first = ctxFor('give me jobs for my cv');
    await search.run({}, first.ctx);
    const list = (first.blocks.find((b) => b.kind === 'jobList') as Extract<AgentBlock, { kind: 'jobList' }>).card;
    const again = ctxFor('Give me 20 most suitable jobs for my resume', list);
    const out = (await search.run({ count: 20 }, again.ctx)) as { instruction: string };
    const shown = (again.blocks.find((b) => b.kind === 'jobList') as Extract<AgentBlock, { kind: 'jobList' }>).card;
    assert.ok(shown.items.every((j) => !list.items.some((old) => old.id === j.id)), 'no job repeated');
    assert.equal(shown.items.length, 10);
    assert.match(out.instruction, /next 10/);
    const other = ctxFor('Give me 20 nursing jobs', list);
    await search.run({ role: 'nursing', count: 20 }, other.ctx);
    assert.equal(d.requests.at(-1)!.keywords.join(), 'nursing', 'a different search starts at the top');
});

test('"could suit you" is not allowed on a stretch', async () => {
    assert.equal(honestSummary('This role could suit you given your data experience.', 'stretch'), undefined);
    assert.equal(honestSummary('This role requires 5+ years, which your CV does not show.', 'stretch'), 'This role requires 5+ years, which your CV does not show.');
});
