import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentJobsDb, LIVE_PROJECT_REF } from './jobs/db';
import { jobPay, keywordScore, orderJobs, passesFilters, rankByReading, seniority, type CandidateJob } from './jobs/readOnlyRank';
import { candidatesFromDatabase, rankWithDatabase, titleVariants } from './jobs/search';

const LIVE = `https://${LIVE_PROJECT_REF}.supabase.co`;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const job = (id: number, title: string, extra: Partial<CandidateJob> = {}): CandidateJob => ({ id, title, description: '', location: 'London', created_at: '2026-11-20T00:00:00Z', ...extra });

test('the agent reads live only through its own read-only settings, or when SUPABASE_URL is live', () => {
    assert.deepEqual(agentJobsDb({ AGENT_JOBS_SUPABASE_URL: LIVE, AGENT_JOBS_SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 't' }), { url: LIVE, key: 'k', readOnly: true });
    assert.equal(agentJobsDb({ SUPABASE_URL: LIVE, SUPABASE_SERVICE_ROLE_KEY: 'k' })?.readOnly, true, 'live is read-only whatever the settings say');
    assert.equal(agentJobsDb({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 't' })?.readOnly, false);
    assert.equal(agentJobsDb({}), null);
});

test('filters match the database ranking', () => {
    const f = (j: CandidateJob, filters: Parameters<typeof passesFilters>[1]) => passesFilters(j, filters, NOW);
    assert.ok(f(job(1, 'Chef', { location: 'London, UK' }), { location: 'london' }));
    assert.ok(f(job(1, 'Chef', { location: 'United Kingdom', description: 'Based in our London kitchen' }), { location: 'London' }), 'generic UK with the town in the advert');
    assert.ok(!f(job(1, 'Chef', { location: 'Leeds' }), { location: 'London' }));
    assert.ok(f(job(1, 'Chef', { location: 'Leeds', all_locations: ['London'] }), { location: 'London' }));
    assert.ok(!f(job(1, 'Chef', { location: 'London' }), { exclude_locations: ['london'] }));
    assert.ok(f(job(1, 'Dev', { description: 'This is a fully remote role' }), { remote: true }));
    assert.ok(!f(job(1, 'Dev', { description: 'Office based' }), { remote: true }));
    assert.ok(f(job(1, 'Dev', { location: 'Hybrid - Leeds' }), { hybrid: true }));
    assert.ok(!f(job(1, 'Dev', { job_type: 'Contract' }), { job_types: ['Full-time'] }));
    assert.ok(f(job(1, 'Dev', { salary: '£45,000 - £55,000' }), { min_pay: 50_000 }));
    assert.ok(!f(job(1, 'Dev', { salary: 'Competitive' }), { min_pay: 30_000 }), 'unknown pay does not pass a pay filter');
    assert.ok(!f(job(1, 'Dev', { sponsorship_outcome: 'not_eligible' }), { visa: true }));
    assert.ok(f(job(1, 'Dev', { sponsorship_outcome: null }), { visa: true }), '"not sure" stays');
    assert.ok(!f(job(1, 'Dev', { company_id: 7 }), { company_ids: [8] }));
    assert.ok(!f(job(1, 'Dev', { created_at: '2026-10-01T00:00:00Z' }), { posted_within_days: 7 }));
    assert.ok(!f(job(5, 'Dev'), { exclude_job_ids: [5] }));
    assert.equal(jobPay(null, 'Salary: £32,500 per year'), 32_500);
});

test('keywords, seniority and one advert per company and role follow the SQL rules', () => {
    assert.equal(keywordScore(job(1, 'Data Analyst', { description: 'SQL and Python daily' }), ['sql', 'python', 'tableau', 'excel']), 0.5);
    assert.equal(keywordScore(job(1, 'Analyst', { description: 'mysql only' }), ['sql']), 0, 'whole words only');
    assert.equal(seniority(job(1, 'Senior Data Analyst'), 3), 'too_senior');
    assert.equal(seniority(job(1, 'Staff Nurse'), 1), null, '"Staff" alone is not senior');
    assert.equal(seniority(job(1, 'Graduate Analyst'), 6), 'too_junior');
    assert.equal(seniority(job(1, 'Analyst', { description: 'You will have 5+ years of experience' }), 2), 'too_senior');
    assert.equal(seniority(job(1, 'Senior Data Analyst'), null), null);
    const ranked = orderJobs([
        { job: job(1, 'Data Analyst (Ref 12)', { company_id: 3 }), meaning: 0.9, keyword: 0.5, seniority: null },
        { job: job(2, 'Data Analyst', { company_id: 3 }), meaning: 0.88, keyword: 0.5, seniority: null },
        { job: job(3, 'BI Analyst', { company_id: 4 }), meaning: 0.9, keyword: 1, seniority: null },
    ], 10);
    assert.deepEqual(ranked.map((r) => r.job_id), [3, 1], 'keywords decide inside a meaning band; the same role at one company shows once');
});

test('rankByReading orders by meaning, and falls back to keywords when embedding fails', async () => {
    const jobs = [job(1, 'Retail Assistant', { description: 'tills' }), job(2, 'Data Analyst', { description: 'SQL dashboards' }), job(3, 'Data Engineer', { description: 'SQL pipelines', location: 'Leeds' })];
    const vec: Record<string, number[]> = { Retail: [0, 1], Data: [1, 0] };
    const request = { query: [{ v: '[1,0]', w: 1 }], keywords: ['sql'], cvYears: null, filters: { location: 'London' }, limit: 10 };
    const seen: string[][] = [];
    const ranked = await rankByReading(request, new AbortController().signal, {
        load: async (terms) => (seen.push(terms), jobs),
        embed: async (texts) => texts.map((t) => vec[t.split(' ')[0]!]!),
        now: () => NOW,
    });
    assert.deepEqual(seen, [['sql']]);
    assert.deepEqual(ranked.map((r) => r.job_id), [2, 1], 'Leeds job filtered out; meaning first');
    const fallback = await rankByReading(request, new AbortController().signal, { load: async () => jobs, embed: async () => { throw new Error('down'); }, now: () => NOW });
    assert.deepEqual(fallback.map((r) => r.job_id), [2, 1], 'keywords decide without meaning');
});

test('the role from the CV picks the jobs; a listed skill in a title does not take over', async () => {
    assert.deepEqual(titleVariants(['fullstack developer']), ['fullstack developer', 'fullstack engineer', 'full stack developer', 'full stack engineer', 'full-stack developer', 'full-stack engineer']);
    const jobs = [job(1, 'Java Engineer', { description: 'Java and Spring' }), job(2, 'C++ Developer', { description: 'C++' }), job(3, 'Full Stack Engineer', { description: 'React and Node.js' })];
    const seen: Array<string[] | undefined> = [];
    const ranked = await rankByReading(
        { titles: titleVariants(['fullstack developer']), query: [{ v: '[1,0]', w: 1 }], keywords: ['fullstack developer', 'node.js', 'java', 'c++'], cvYears: 1, filters: {}, limit: 10 },
        new AbortController().signal,
        { load: async (_terms, _f, _s, titles) => (seen.push(titles), jobs), embed: async (texts) => texts.map(() => [1, 0]), now: () => NOW },
    );
    assert.ok(seen[0]?.includes('full stack engineer'), 'the role titles reach the database read');
    assert.equal(ranked[0]?.job_id, 3, 'the full-stack job leads, not the Java or C++ one');
    assert.equal(keywordScore(job(1, 'Dev', { description: 'APIs in Node.js' }), ['node.js']), 1, '"Node.js" is matched as written');
});

test('with the live database the agent only sends GET requests and never calls a database function', async () => {
    const saved = { ...process.env };
    const realFetch = globalThis.fetch;
    const requests: Array<{ method: string; url: string }> = [];
    process.env.AGENT_JOBS_SUPABASE_URL = LIVE;
    process.env.AGENT_JOBS_SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    delete process.env.SOC_EMBED_FUNCTION_URL;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        requests.push({ method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), url });
        return new Response(JSON.stringify([{ id: 1, title: 'Data Analyst', description: 'SQL', location: 'London', created_at: '2026-11-20T00:00:00Z' }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
        const signal = new AbortController().signal;
        const candidates = await candidatesFromDatabase(['data analyst'], { location: 'London' }, signal);
        assert.equal(candidates[0]?.id, 1);
        const ranked = await rankWithDatabase({ query: [{ v: '[1,0]', w: 1 }], keywords: ['sql'], cvYears: null, filters: {}, limit: 10 }, signal);
        assert.deepEqual(ranked.map((r) => r.job_id), [1]);
        const toLive = requests.filter((r) => r.url.startsWith(LIVE));
        assert.ok(toLive.length >= 3);
        assert.deepEqual([...new Set(toLive.map((r) => r.method))], ['GET']);
        assert.ok(!toLive.some((r) => r.url.includes('/rpc/')), 'no database function is called on live');
    } finally {
        globalThis.fetch = realFetch;
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
    }
});
