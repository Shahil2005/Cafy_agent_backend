import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ADVERT_CHARS, sharedKeywords, splitPastedAdvert, userWords } from './jobs/jobDescription';

const ADVERT = `Business Intelligence Analyst - Leeds (Hybrid)
About the role: We are a growing UK retailer looking for a Business Intelligence Analyst to join our commercial insights team.
Responsibilities:
- Build and maintain Power BI dashboards for trading and supply chain teams
- Write SQL to extract and model data from our Snowflake warehouse
- Analyse sales, pricing and promotions performance and present findings to senior stakeholders
Requirements:
- 2+ years in a data or BI analyst role
- Strong SQL; experience with Power BI or Tableau
Salary: £35,000 - £42,000 per annum. You must have the right to work in the UK; we cannot offer visa sponsorship.`;

test('an advert followed by the request: the request is the user\'s words, the rest is the advert', () => {
    const pasted = splitPastedAdvert(`${ADVERT}\n\nGive me jobs for my CV like this one`)!;
    assert.equal(pasted.ask, 'Give me jobs for my CV like this one');
    assert.ok(pasted.advert.startsWith('Business Intelligence Analyst'));
    assert.ok(!pasted.advert.includes('Give me jobs'));
    assert.ok(!/leeds|sponsorship|£35/i.test(pasted.ask), 'the advert\'s place, pay and visa words stay out of the request');
});

test('a request before the advert', () => {
    const pasted = splitPastedAdvert(`Find me jobs similar to this JD that suit my CV:\n${ADVERT}`)!;
    assert.equal(pasted.ask, 'Find me jobs similar to this JD that suit my CV:');
    assert.ok(pasted.advert.startsWith('Business Intelligence Analyst'));
});

test('a request on both sides, and a place the user asks for themselves', () => {
    const pasted = splitPastedAdvert(`Can you find jobs like this?\n${ADVERT}\nbut in Manchester please`)!;
    assert.match(pasted.ask, /^Can you find jobs like this\? but in Manchester please$/);
});

test('only an advert: no request words, and the advert\'s own closing line stays in it', () => {
    const pasted = splitPastedAdvert(`${ADVERT}\nApply now via our website`)!;
    assert.equal(pasted.ask, '');
    assert.ok(pasted.advert.endsWith('Apply now via our website'));
});

test('ordinary messages are not adverts', () => {
    assert.equal(splitPastedAdvert('Give me data analyst jobs in Leeds'), null);
    assert.equal(splitPastedAdvert('What does a business intelligence analyst do, and what skills and experience do I need to become one? I have a maths degree and some Excel experience, and I am wondering whether it is worth learning Power BI or Tableau first, and how long it usually takes to get a first role in the UK.'), null);
    assert.equal(userWords('Give me data analyst jobs in Leeds'), 'Give me data analyst jobs in Leeds');
});

test('a very long advert is kept to the search limit', () => {
    const long = `${ADVERT}\n${'- Work with stakeholders across the business to improve reporting.\n'.repeat(200)}\nfind me jobs like this`;
    const pasted = splitPastedAdvert(long)!;
    assert.equal(pasted.ask, 'find me jobs like this');
    assert.equal(pasted.advert.length, MAX_ADVERT_CHARS);
});

test('shared keywords are the CV words the advert also names, whole words only', () => {
    assert.deepEqual(sharedKeywords(['SQL', 'Tableau', 'Python', 'R', 'Data Analyst', 'Excel'], ADVERT), ['SQL', 'Tableau']);
});

// ---- Search with a pasted advert ----
import { searchJobs, type JobDetail, type JobSearchDeps, type RankRequest } from './jobs/search';
import { createJobTools } from './tools/jobs';
import type { AgentBlock, JobListCard } from './contract';
import type { ToolContext } from './tools';

const CV_TEXT = 'Built SQL pipelines and Excel reports.';
const cv = {
    version: 4, name: 'CV.pdf', hash: 'h', createdAt: 0, expiresAt: 0, text: CV_TEXT,
    profile: {
        headline: 'Data analyst', roles: [{ title: 'Data Analyst', type: 'job', start: '2022', end: '2025', evidence: 'x' }], education: [],
        skills: [{ name: 'Excel', source: 'skills-list', evidence: 'x' }, { name: 'SQL', source: 'experience', evidence: 'x' }],
        projects: [], achievements: [], certifications: [], languages: [], hasPersonalStatement: false,
    },
    chunks: [{ index: 0, section: 'Experience', text: CV_TEXT, embedding: [0.1, 0.2] }],
} as never;

function deps(): JobSearchDeps & { requests: RankRequest[]; embedded: string[] } {
    const requests: RankRequest[] = [];
    const embedded: string[] = [];
    return {
        requests,
        embedded,
        rank: async (request) => { requests.push(request); return [1, 2].map((job_id) => ({ job_id, meaning: 0.9, keyword: 0.5, seniority: null })); },
        details: async (ids) => ids.map((id): JobDetail => ({ id, title: `BI Analyst ${id}`, company: 'Acme', location: 'London', sponsor: false })),
        companyIds: async () => [],
        embed: async (text) => { embedded.push(text); return [0.3, 0.4]; },
        explain: async () => [],
    };
}
const signal = new AbortController().signal;

test('a pasted advert is the meaning query; the CV only personalises', async () => {
    const d = deps();
    const outcome = await searchJobs({ role: 'Business Intelligence Analyst' }, { cv, years: 3, signal, advert: ADVERT }, d);
    const request = d.requests[0]!;
    assert.ok(d.embedded.some((text) => text.includes('Power BI dashboards')), 'the advert text itself is embedded');
    assert.ok(request.query.length >= 2, 'advert pieces plus the job title');
    assert.ok(!request.query.some((q) => q.v === '[0.1,0.2]'), 'never the CV pieces');
    assert.deepEqual(request.keywords, ['SQL'], 'shared CV and advert words break ties');
    assert.deepEqual(request.filters, {}, 'nothing from the advert becomes a filter');
    assert.ok(outcome.status === 'ok');
    assert.equal(outcome.card.fromCv, false);
    assert.equal(outcome.card.search.advert, ADVERT, 'kept, so "more" searches the same advert');
    assert.match(outcome.card.query, /advert/i);
});

function toolContext(message: string, advert: string | undefined, lastJobs?: JobListCard) {
    const blocks: AgentBlock[] = [];
    const ctx: ToolContext = { uid: 'u', signal, cv, userMessage: message, ...(advert ? { advert } : {}), ...(lastJobs ? { lastJobs, jobLists: [lastJobs] } : {}), emit: (_id, block) => blocks.push(block) };
    return { ctx, blocks };
}

test('search_jobs drops the advert\'s place, pay and type even when the model copies them', async () => {
    const d = deps();
    const [search] = createJobTools(d);
    const pasted = splitPastedAdvert(`${ADVERT}\n\nGive me jobs for my CV like this one`)!;
    await search!.run({ role: 'Business Intelligence Analyst', location: 'Leeds', minPay: 35000, jobTypes: ['full-time'], needsVisa: true }, toolContext(pasted.ask, pasted.advert).ctx);
    assert.deepEqual(d.requests[0]!.filters, {});
    assert.equal(d.requests[0]!.query.length >= 2, true);
});

test('a place the user asks for themselves is kept', async () => {
    const d = deps();
    const [search] = createJobTools(d);
    const pasted = splitPastedAdvert(`Can you find jobs like this?\n${ADVERT}\nbut in Manchester please`)!;
    await search!.run({ role: 'Business Intelligence Analyst', location: 'Manchester' }, toolContext(pasted.ask, pasted.advert).ctx);
    assert.deepEqual(d.requests[0]!.filters, { location: 'Manchester' });
});

test('"more" after an advert search searches the same advert again', async () => {
    const d = deps();
    const [search] = createJobTools(d);
    const pasted = splitPastedAdvert(`${ADVERT}\n\nfind me jobs like this`)!;
    const first = toolContext(pasted.ask, pasted.advert);
    await search!.run({ role: 'Business Intelligence Analyst' }, first.ctx);
    const list = (first.blocks.find((b) => b.kind === 'jobList') as Extract<AgentBlock, { kind: 'jobList' }>).card;
    d.embedded.length = 0;
    const out = (await search!.run({ more: true }, toolContext('show me more', undefined, list).ctx)) as { error?: string };
    assert.ok(d.embedded.some((text) => text.includes('Power BI dashboards')), 'the stored advert is searched again');
    assert.deepEqual(d.requests[1]!.filters, {}, 'the same request as the advert search, so its cached ranking answers');
    assert.equal(out.error, 'NO_MORE_JOBS', 'both matching jobs were already shown');
});

test('job_fit reads a pasted advert when no job card is named, and keeps adverts apart', async () => {
    const d = deps();
    const read: JobDetail[] = [];
    d.explain = async (_cv, jobs) => { read.push(...jobs); return jobs.map((j) => ({ id: j.id, summary: 'Close to your SQL work.', have: [{ skill: 'SQL', quote: 'Built SQL pipelines' }], missing: ['Power BI'] })); };
    const fit = createJobTools(d).find((t) => t.name === 'job_fit')!;
    const result = (await fit.run({}, toolContext('Does my CV fit this job?', ADVERT).ctx)) as { title: string; source?: string; matches: unknown[]; missing: string[] };
    assert.equal(result.title, 'Business Intelligence Analyst - Leeds (Hybrid)');
    assert.equal(result.source, 'the advert the user pasted');
    assert.equal(result.matches.length, 1, 'only quotes really in the CV');
    assert.deepEqual(result.missing, ['Power BI']);
    assert.ok(read[0]!.id < 0, 'a pasted advert never shares an id with a catalogue job');
    const other = (await import('./tools/jobs')).pastedAdvertJob(`${ADVERT}\nExtra line`);
    assert.notEqual(other.id, read[0]!.id, 'two adverts never share a cached reading');
    const none = (await fit.run({}, toolContext('Does my CV fit?', undefined).ctx)) as { error?: string };
    assert.equal(none.error, 'NO_SUCH_JOB');
});
