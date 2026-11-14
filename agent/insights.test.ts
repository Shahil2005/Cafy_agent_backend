import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentBlock, JobListCard } from './contract';
import { buildJobComparison, commonGaps } from './jobs/compare';
import { payStats, yearlyPay } from './jobs/salary';
import { createInsightTools } from './tools/insights';
import type { ToolContext } from './tools';
import type { CvIndex } from './cv';

type Item = JobListCard['items'][number];

const job = (id: number, extra: Partial<Item> = {}): Item => ({ id, title: `Job ${id}`, sponsor: false, have: [], missing: [], ...extra });
const list = (items: Item[]): JobListCard => ({ query: 'Data jobs', fromCv: true, fewCloseMatches: false, search: {}, shownIds: items.map((i) => i.id), items });

function context(extra: Partial<ToolContext> = {}) {
    const blocks: Array<{ id: string; block: AgentBlock }> = [];
    const ctx: ToolContext = { uid: 'u1', signal: new AbortController().signal, cv: null, userMessage: '', emit: (id, block) => blocks.push({ id, block }), ...extra };
    return { ctx, blocks };
}
const fakeCv = { text: 'cv', profile: { roles: [], skills: [] }, chunks: [] } as unknown as CvIndex;

test('yearly pay: ranges, k figures and single amounts', () => {
    assert.equal(yearlyPay('£30,000 - £40,000 per annum'), 35000);
    assert.equal(yearlyPay('£30,000 - 40,000'), 35000);
    assert.equal(yearlyPay('£45k'), 45000);
    assert.equal(yearlyPay('£28k–£32k a year'), 30000);
    assert.equal(yearlyPay('Up to £52,500'), 52500);
    assert.equal(yearlyPay('£27,500 pa + benefits'), 27500);
});

test('yearly pay: "GBP" written as a word, as many adverts in the catalogue do', () => {
    assert.equal(yearlyPay('Job Ad Salary Range: 75000 - 115000 GBP Annual'), 95000);
    assert.equal(yearlyPay('Job Ad Salary Range: 75,000 - 115,000 GBP Annual'), 95000);
    assert.equal(yearlyPay('40000-50000 GBP per year'), 45000);
    assert.equal(yearlyPay('GBP 40,000 - 45,000'), 42500);
    assert.equal(yearlyPay('35k GBP'), 35000);
    for (const salary of ['Salary: 5616', '£0 - £0', '£24.48', '15 GBP per hour', '2026 GBP 40000 - 45000 - 50000', 'Pay Basis: Hourly Rate ..'])
        assert.equal(yearlyPay(salary), null, salary);
});

test('yearly pay: never converts or guesses', () => {
    for (const salary of ['£12.50 per hour', '£12.50/hr', '£150 per day', '£2,500 per month', '£500 a week', '$90,000', '€40,000', '£30,000 pro rata', '£40,000 OTE', 'Competitive', '£5,000 bonus', '£20,000 - £25,000 plus £3,000 bonus and £1,000 allowance', '', null, '£2,000,000']) {
        assert.equal(yearlyPay(salary), null, String(salary));
    }
});

test('pay stats need enough adverts, then give median and quartiles', () => {
    assert.equal(payStats([30000, 40000, 50000]), null);
    const stats = payStats([20000, 25000, 30000, 35000, 40000, 45000, 50000, 55000, 60000]);
    assert.deepEqual(stats, { samples: 9, median: 40000, lowerQuartile: 30000, upperQuartile: 50000, lowest: 20000, highest: 60000 });
});

test('comparison keeps stored facts and picks the closest only when the CV read every job', () => {
    const items = [
        job(1, { salary: '£30,000', verdict: { label: 'possible', reason: 'r' }, missing: ['Python', 'SQL'], have: [{ skill: 'Excel', quote: 'q' }] }),
        job(2, { verdict: { label: 'close', reason: 'r' }, have: [{ skill: 'SQL', quote: 'q' }, { skill: 'Excel', quote: 'q' }], sponsor: true }),
    ];
    const card = buildJobComparison(items);
    assert.equal(card.closestId, 2);
    assert.equal(card.jobs[0]!.salary, '£30,000');
    assert.deepEqual(card.jobs[1]!.have, ['SQL', 'Excel']);
    assert.equal(card.jobs[1]!.sponsorLicence, true);
    assert.equal(buildJobComparison([job(1), job(2)]).closestId, undefined, 'no CV reading: no pick');
});

test('common gaps count each job once and put the most common first', () => {
    const gaps = commonGaps([job(1, { missing: ['Python', 'python', 'Tableau'] }), job(2, { missing: ['Python'] }), job(3, { missing: ['AWS'] })]);
    assert.deepEqual(gaps[0], { skill: 'Python', jobs: 2 });
    assert.equal(gaps.length, 3);
});

test('compare_jobs shows a card for positions on screen and refuses unknown ones', async () => {
    const [compare] = createInsightTools({ pay: async () => [] });
    const lastJobs = list([job(1), job(2), job(3)]);
    const { ctx, blocks } = context({ lastJobs, jobLists: [lastJobs] });
    const result = (await compare!.run({ positions: [1, 3] }, ctx)) as { jobs: Array<{ position: number }> };
    assert.deepEqual(result.jobs.map((j) => j.position), [1, 3]);
    assert.equal(blocks[0]!.block.kind, 'jobCompare');
    const missing = (await compare!.run({ positions: [1, 9] }, context({ lastJobs }).ctx)) as { error?: string };
    assert.equal(missing.error, 'NO_SUCH_JOBS');
});

test('skill_gaps needs a CV and read jobs', async () => {
    const [, gaps] = createInsightTools({ pay: async () => [] });
    const lastJobs = list([job(1, { missing: ['Python'], verdict: { label: 'possible', reason: 'r' } }), job(2, { missing: ['Python', 'dbt'], verdict: { label: 'stretch', reason: 'r' } })]);
    assert.equal(((await gaps!.run({}, context({ lastJobs }).ctx)) as { error?: string }).error, 'NEED_CV');
    assert.equal(((await gaps!.run({}, context({ cv: fakeCv }).ctx)) as { error?: string }).error, 'NO_JOBS_ON_SCREEN', 'no jobs on screen: search first');
    const { ctx, blocks } = context({ cv: fakeCv, lastJobs, jobLists: [lastJobs] });
    const result = (await gaps!.run({}, ctx)) as { gaps: Array<{ skill: string; jobs: number }> };
    assert.deepEqual(result.gaps[0], { skill: 'Python', jobs: 2 });
    assert.equal(blocks[0]!.block.kind, 'skillGaps');
});

test('salary_stats gives figures only from enough real yearly adverts', async () => {
    const adverts = ['£30,000', '£32,000', '£34,000', '£36,000', '£38,000', '£40,000', '£42,000', '£44,000', '£12 per hour', 'Competitive'];
    const [, , pay] = createInsightTools({ pay: async () => adverts });
    const { ctx, blocks } = context();
    const result = (await pay!.run({ role: 'data analyst' }, ctx)) as { median: number; samples: number };
    assert.equal(result.samples, 8, 'hourly and vague pay are left out');
    assert.equal(result.median, 37000);
    assert.equal(blocks[0]!.block.kind, 'answerCard');

    const [, , thin] = createInsightTools({ pay: async () => ['£30,000', '£12 per hour'] });
    const none = context();
    assert.equal(((await thin!.run({ role: 'astronaut' }, none.ctx)) as { error?: string }).error, 'NOT_ENOUGH_PAY_DATA');
    assert.equal(none.blocks.length, 0, 'no card without enough data');

    const [, , down] = createInsightTools({ pay: async () => { throw new Error('db down'); } });
    assert.equal(((await down!.run({ role: 'nurse' }, context().ctx)) as { error?: string }).error, 'PAY_UNAVAILABLE');
});

test('a mock interview request is told apart from a request for a question list', async () => {
    const { startsMockInterview } = await import('./interview');
    for (const yes of ['Give me a mock interview for a data analyst role', 'Interview me for job 2', 'Can we practise the interview?', 'practice for an interview at Tesco'])
        assert.equal(startsMockInterview(yes), true, yes);
    for (const no of ['What questions might I be asked in a mock interview?', 'common interview questions for nurses', 'How did my interview go?'])
        assert.equal(startsMockInterview(no), false, no);
});

test('the mock interview keeps its place from the conversation', async () => {
    const { interviewState, asksInterviewQuestion } = await import('./interview');
    const asked = (n: number, of = 5) => [{ role: 'user' as const, text: 'mock interview please' }, { role: 'assistant' as const, text: `Good. **Question ${n} of ${of}:** Tell me about a time you led a team.` }];
    assert.deepEqual(interviewState([], 'Give me a mock interview'), { asked: 0, total: 5, next: 1, finish: false });
    assert.equal(interviewState([], 'How much do nurses earn?'), null);
    assert.deepEqual(interviewState(asked(2), 'I organised the rota and we cut overtime'), { asked: 2, total: 5, next: 3, finish: false });
    assert.equal(interviewState(asked(5), 'We delivered on time')!.finish, true, 'last answer: summary');
    assert.equal(interviewState(asked(2), 'stop, that is enough')!.finish, true);
    assert.equal(interviewState(asked(3), 'Interview me for job 3 instead')!.next, 1, 'a new request starts again');
    const state = interviewState(asked(2), 'my answer')!;
    assert.equal(asksInterviewQuestion('Nice. **Question 3 of 5:** Why us?', state), true);
    assert.equal(asksInterviewQuestion('Nice answer, well done.', state), false);
    assert.equal(asksInterviewQuestion('Thanks, all done.', interviewState(asked(5), 'answer')!), true, 'nothing to ask at the end');
});
