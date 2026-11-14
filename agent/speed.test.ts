import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forcedToolCalls, isPlainJobsLikeAdvert } from './routing';
import { cached, peekCached, saveCached, type CacheStore } from './cache';
import { cvFallbackPhrases, searchJobs, type JobSearchDeps } from './jobs/search';

const tools = new Set(['search_jobs', 'get_cv_profile', 'gov_uk_guidance', 'find_sponsors', 'soc_lookup', 'get_experience_years', 'visa_salary_rules']);
const searches = (message: string, hasCv = true) => forcedToolCalls(message, tools, { hasCv }).some((call) => call.name === 'search_jobs');

test('a plain "jobs for my CV" starts the search at once (no planning call)', () => {
    for (const message of ['Give me jobs for my CV', 'give me jobs matching my cv', 'Find me a job', 'Can you find jobs that fit my experience?', 'jobs for me please', 'Show me suitable roles based on my CV'])
        assert.equal(searches(message), true, message);
});

test('anything more than that still goes through the model, which passes the details', () => {
    for (const message of ['data jobs for my CV', 'jobs for my CV in Leeds', 'remote jobs for my CV', 'give me the best job for my cv', 'give me 3 jobs for my cv', 'more jobs for my cv', 'part-time jobs for me', 'jobs for my CV that sponsor visas', 'jobs for my cv paying over £30k', 'other jobs for my cv', 'what jobs suit my CV and why?', 'How do I find jobs for my CV?'])
        assert.equal(searches(message), false, message);
    assert.equal(searches('Give me jobs for my CV', false), false, 'without a CV the model asks for one');
});

function fakeStore() {
    const data = new Map<string, unknown>();
    const store: CacheStore & { data: Map<string, unknown> } = { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); return 'OK'; } };
    return store;
}

test('the cache returns the saved value and runs the work once', async () => {
    const store = fakeStore();
    let runs = 0;
    const work = async () => { runs++; return [1, 2, 3]; };
    assert.deepEqual(await cached('k', 60, work, { store }), [1, 2, 3]);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(await cached('k', 60, work, { store }), [1, 2, 3]);
    assert.equal(runs, 1);
});

test('a broken, slow or wrong-shaped cache never breaks or slows the answer', async () => {
    const broken: CacheStore = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
    assert.deepEqual(await cached('k', 60, async () => 'fresh', { store: broken }), 'fresh');
    const slow: CacheStore = { get: () => new Promise((r) => setTimeout(() => r('stale'), 5_000)), set: async () => 'OK' };
    const started = Date.now();
    assert.equal(await cached('k', 60, async () => 'fresh', { store: slow }), 'fresh');
    assert.ok(Date.now() - started < 3_000, 'a slow cache counts as a miss');
    const wrong = fakeStore();
    wrong.data.set('k', 'not rows');
    assert.deepEqual(await cached('k', 60, async () => [1], { store: wrong, valid: (v): v is number[] => Array.isArray(v) }), [1]);
    await assert.rejects(cached('e', 60, async () => { throw new Error('db'); }, { store: fakeStore() }), /db/, 'work errors are not hidden or cached');
});

test('the same slow work asked for twice at once runs once', async () => {
    const store = fakeStore();
    let runs = 0;
    const work = () => new Promise<number[]>((resolve) => { runs++; setTimeout(() => resolve([7]), 50); });
    const [a, b] = await Promise.all([cached('same', 60, work, { store }), cached('same', 60, work, { store })]);
    assert.deepEqual(a, [7]);
    assert.deepEqual(b, [7]);
    assert.equal(runs, 1, 'a retry joins the running work instead of starting a second scan');
    await assert.rejects(cached('fails', 60, async () => { throw new Error('db'); }, { store }));
    assert.deepEqual(await cached('fails', 60, async () => [1], { store }), [1], 'a failed run is not remembered');
});

const cvForSearch = {
    version: 5, name: 'CV.pdf', hash: 'h', createdAt: 0, expiresAt: 0,
    text: 'Full stack developer. Built React and Node.js apps with PostgreSQL.',
    profile: { headline: 'Full stack developer', roles: [{ title: 'Full Stack Developer', type: 'job', evidence: 'x' }], education: [], skills: [{ name: 'React', source: 'experience', evidence: 'x' }, { name: 'Node.js', source: 'experience', evidence: 'x' }], projects: [], achievements: [], certifications: [], languages: [], hasPersonalStatement: false },
    chunks: [{ index: 0, section: 'Experience', text: 'Full stack developer. Built React and Node.js apps with PostgreSQL.', embedding: [0.1, 0.2] }],
} as never;

function slowDeps(over: Partial<JobSearchDeps> = {}) {
    const titleAsks: string[][] = [];
    const deps: JobSearchDeps = {
        rank: () => new Promise((resolve) => setTimeout(() => resolve([{ job_id: 99, meaning: 0.9, keyword: 0, seniority: null }]), 300)),
        details: async (ids) => ids.map((id) => ({ id, title: id === 2 ? 'Full-Stack Developer (React)' : 'Full Stack Engineer', company: 'Acme', sponsor: false })),
        companyIds: async () => [],
        embed: async () => [0.5, 0.5],
        explain: async () => [],
        titleJobs: async (phrases) => { titleAsks.push(phrases); return [{ id: 1, title: 'Full Stack Engineer', description: 'Vue and PHP' }, { id: 2, title: 'Full-Stack Developer (React)', description: 'React and Node.js' }]; },
        ...over,
    };
    return { deps, titleAsks };
}

test('a ranking that is too slow: jobs with the asked-for title are shown instead of an error', async () => {
    const { deps, titleAsks } = slowDeps();
    const out = await searchJobs({ role: 'full-stack' }, { cv: cvForSearch, years: 2, signal: new AbortController().signal, slowRankMs: 20 }, deps);
    assert.equal(out.status, 'ok');
    const ok = out as Extract<typeof out, { status: 'ok' }>;
    assert.equal(ok.byTitle, true);
    assert.deepEqual(titleAsks[0], ['full-stack', 'full stack'], 'both spellings of the role');
    assert.deepEqual(ok.card.items.map((j) => j.id), [2, 1], 'the one using more of the CV first');
    assert.match(ok.card.query, /matched by job title/);
    assert.ok(!ok.card.items.some((j) => j.id === 99), 'the late ranking does not mix in');
});

test('a fast ranking is used as before and no title lookup runs for a named role', async () => {
    const { deps, titleAsks } = slowDeps({ rank: async () => [{ job_id: 99, meaning: 0.9, keyword: 0, seniority: null }] });
    const out = await searchJobs({ role: 'full-stack' }, { cv: cvForSearch, years: 2, signal: new AbortController().signal, slowRankMs: 1_000 }, deps);
    assert.ok(out.status === 'ok' && !out.byTitle && out.card.items[0]!.id === 99);
    assert.equal(titleAsks.length, 0);
});

test('a filter a title cannot honour waits for the full ranking, never shows unfiltered jobs', async () => {
    for (const settings of [{ role: 'full-stack', minPay: 50_000 }, { role: 'full-stack', needsVisa: true }, { role: 'full-stack', excludeLocations: ['London'] }]) {
        const { deps, titleAsks } = slowDeps();
        const out = await searchJobs(settings, { cv: cvForSearch, years: 2, signal: new AbortController().signal, slowRankMs: 20 }, deps);
        assert.ok(out.status === 'ok' && !out.byTitle && out.card.items[0]!.id === 99, JSON.stringify(settings));
        assert.equal(titleAsks.length, 0);
    }
    const { deps } = slowDeps({ titleJobs: async () => [] });
    await assert.rejects(searchJobs({ role: 'full-stack' }, { cv: cvForSearch, years: 2, signal: new AbortController().signal, slowRankMs: 20 }, deps), /too slow/, 'no title match either: still reported as slow');
});

test('a place, remote, job type and date go into the title lookup, so the fallback keeps them', async () => {
    const seen: unknown[] = [];
    const { deps } = slowDeps();
    const withFilters: JobSearchDeps = { ...deps, titleJobs: async (phrases, excluded, signal, filters) => { seen.push(filters); return deps.titleJobs!(phrases, excluded, signal); } };
    const out = await searchJobs({ role: 'chef', location: 'London', jobTypes: ['part-time'], postedWithinDays: 7 }, { cv: cvForSearch, years: 2, signal: new AbortController().signal, slowRankMs: 20 }, withFilters);
    assert.ok(out.status === 'ok' && out.byTitle);
    assert.deepEqual(seen[0], { location: 'London', jobTypes: ['Part-time'], postedWithinDays: 7 });
    seen.length = 0;
    await searchJobs({ remote: true }, { cv: cvForSearch, years: 2, signal: new AbortController().signal, slowRankMs: 20 }, withFilters);
    assert.deepEqual(seen[0], { remote: true }, 'a CV search with a filter looks up the CV title with that filter');
});

test('a slow CV search falls back to jobs with the CV\'s own title', async () => {
    const { deps } = slowDeps();
    const out = await searchJobs({}, { cv: cvForSearch, years: 2, signal: new AbortController().signal, slowRankMs: 20 }, deps);
    assert.ok(out.status === 'ok' && out.byTitle && out.card.fromCv && out.card.items.length > 0);
});

test('a pasted advert with only "jobs like this" starts the search at once; any other detail goes to the model', () => {
    for (const ask of ['find jobs like this', 'Find me jobs similar to this JD that suit my CV:', 'Give me jobs for my CV like this one', 'similar roles please', 'any others like this?'])
        assert.equal(isPlainJobsLikeAdvert(ask), true, ask);
    for (const ask of ['Does my CV fit this job?', '', 'jobs like this in Manchester', 'find part-time jobs like this', 'write a cover letter for this job', 'is this job a good fit for me'])
        assert.equal(isPlainJobsLikeAdvert(ask), false, ask);
    const advertSearch = (ask: string, pastedAdvert: boolean) => forcedToolCalls(ask, tools, { hasCv: false, pastedAdvert }).some((c) => c.name === 'search_jobs');
    assert.equal(advertSearch('find jobs like this', true), true, 'no CV needed: the advert is the query');
    assert.equal(advertSearch('find jobs like this', false), false, 'without a pasted advert "this" means something else');
});

test('a pasted advert is embedded in one batch when the search can batch', async () => {
    const batches: string[][] = [];
    const { deps } = slowDeps({ rank: async () => [{ job_id: 1, meaning: 0.9, keyword: 0, seniority: null }], embed: async () => { throw new Error('one by one'); }, embedMany: async (texts) => { batches.push(texts); return texts.map(() => [0.5, 0.5]); } });
    const advert = 'Business Intelligence Analyst. You will build Power BI dashboards and write SQL for finance teams. '.repeat(30);
    const out = await searchJobs({}, { cv: cvForSearch, years: 2, signal: new AbortController().signal, advert }, deps);
    assert.equal(out.status, 'ok');
    assert.equal(batches.length, 1);
    assert.ok(batches[0]!.length > 1);
});

test('peeking at the cache never runs work and treats a wrong shape as a miss', async () => {
    const store = fakeStore();
    const isList = (v: unknown): v is number[] => Array.isArray(v);
    assert.equal(await peekCached('p', isList, { store }), null);
    saveCached('p', 60, [1], { store });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(await peekCached('p', isList, { store }), [1]);
    store.data.set('q', 'text');
    assert.equal(await peekCached('q', isList, { store }), null);
});

test('a slow CV search looks up every paid role and each part of a title, not only the latest two', () => {
    const lean = { ...(cvForSearch as object), profile: { ...(cvForSearch as { profile: object }).profile, headline: 'Lean and continuous improvement manager', roles: [
        { title: 'Freelance Lean Trainer and Consultant', type: 'job' },
        { title: 'Business Improvement Lead', type: 'job' },
        { title: 'Continuous Improvement/OPEX Lead', type: 'job' },
        { title: 'Lean/Continuous Improvement Manager', type: 'job' },
        { title: 'Lean Promotion Officer/Manager', type: 'job' },
        { title: 'Charity Shop Helper', type: 'volunteering' },
    ] } } as never;
    const phrases = cvFallbackPhrases(lean);
    for (const wanted of ['business improvement', 'continuous improvement', 'continuous improvement manager', 'lean trainer'])
        assert.ok(phrases.includes(wanted), `${wanted} in ${JSON.stringify(phrases)}`);
    assert.ok(!phrases.includes('lean') && !phrases.includes('opex'), 'one word would also find "cleaner"');
    assert.ok(!phrases.some((p) => /freelance|helper/.test(p)), 'not a title word, and volunteering is not their career');
    assert.ok(phrases.length <= 8);
    const changer = { ...(lean as object), profile: { ...(lean as { profile: object }).profile, headline: 'Former lean manager, now a junior developer' } } as never;
    assert.deepEqual(cvFallbackPhrases(changer), []);
});

test('a card found by title says so, so the page does not claim it was ranked across every job', async () => {
    const { deps } = slowDeps();
    const out = await searchJobs({}, { cv: cvForSearch, years: 2, signal: new AbortController().signal, slowRankMs: 20 }, deps);
    assert.ok(out.status === 'ok' && out.card.byTitle === true);
});
