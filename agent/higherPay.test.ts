import { test } from 'node:test';
import assert from 'node:assert/strict';
import { betterPaid, payRoleFromCv, payStats, yearlyPay } from './jobs/salary';
import { createInsightTools, type PaidAdvert } from './tools/insights';
import { forcedToolCalls } from './routing';
import type { AgentBlock, JobListCard } from './contract';
import type { JobDetail } from './jobs/search';
import type { ToolContext } from './tools';

const profile = (roles: Array<{ title: string; type: string }>, headline = 'Data analyst') =>
    ({ headline, roles, education: [], skills: [], projects: [], achievements: [], certifications: [], languages: [], hasPersonalStatement: false }) as never;

test('the role used for pay is the latest paid job, without its level', () => {
    assert.equal(payRoleFromCv(profile([{ title: 'Junior Data Analyst', type: 'job' }, { title: 'Maths Tutor', type: 'volunteering' }])), 'data analyst');
    assert.equal(payRoleFromCv(profile([{ title: 'Maths Tutor', type: 'volunteering' }], 'Graduate Software Engineer')), 'software engineer');
    assert.equal(payRoleFromCv(profile([], '')), undefined);
});

test('better-paid adverts are those at or above the upper quartile, grouped by title, best paid first', () => {
    const adverts: PaidAdvert[] = [
        ...[30, 31, 32, 33, 34, 35, 36].map((k, i) => ({ id: i + 1, title: 'Data Analyst', salary: `£${k},000` })),
        { id: 20, title: 'Senior Data Analyst', salary: '£50,000 - £60,000' },
        { id: 21, title: 'Senior Data Analyst (Ref 12)', salary: '£54,000' },
        { id: 22, title: 'Lead Data Analyst', salary: '£70,000' },
        { id: 23, title: 'Data Analyst', salary: '£12 per hour' },
    ];
    const stats = payStats(adverts.flatMap((a) => { const pay = yearlyPay(a.salary); return pay === null ? [] : [pay]; }))!;
    const groups = betterPaid(adverts, stats);
    assert.equal(groups[0]!.title, 'Lead Data Analyst');
    assert.equal(groups[1]!.title, 'Senior Data Analyst');
    assert.equal(groups[1]!.adverts, 2, 'bracketed codes do not split a title');
    assert.ok(groups.every((g) => g.typicalPay >= stats.upperQuartile));
});

const cv = {
    version: 5, name: 'CV.pdf', hash: 'h', createdAt: 0, expiresAt: 0,
    text: 'Data Analyst at Brightmart. Wrote SQL queries in PostgreSQL. Built dashboards in Tableau, cutting waste by 12%.',
    profile: { headline: 'Data analyst', roles: [{ title: 'Data Analyst', type: 'job', evidence: 'x' }], education: [], skills: [{ name: 'SQL', source: 'experience', evidence: 'x' }], projects: [], achievements: [{ text: 'Cut waste by 12%', evidence: 'cutting waste by 12%' }], certifications: [], languages: [], hasPersonalStatement: false },
    chunks: [],
} as never;

function context(extra: Partial<ToolContext> = {}) {
    const blocks: AgentBlock[] = [];
    const ctx: ToolContext = { uid: 'u', signal: new AbortController().signal, cv, userMessage: 'What can I improve in my resume to get more earning jobs?', emit: (_id, b) => { blocks.push(b); }, ...extra };
    return { ctx, blocks };
}

const ADVERTS: PaidAdvert[] = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: 'Data Analyst', salary: `£${30 + i},000` })),
    { id: 50, title: 'Senior Data Analyst', salary: '£55,000' },
    { id: 51, title: 'Analytics Engineer', salary: '£60,000' },
];

function deps(read: string[][] = [['Power BI', 'dbt'], ['Power BI']]) {
    const asked: string[] = [];
    return {
        asked,
        paidAdverts: async (role: string) => { asked.push(role); return ADVERTS; },
        details: async (ids: number[]) => ids.map((id): JobDetail => ({ id, title: ADVERTS.find((a) => a.id === id)?.title ?? `Job ${id}`, description: 'advert', sponsor: false })),
        explain: async (_cv: unknown, jobs: JobDetail[]) => jobs.map((j, i) => ({ id: j.id, have: [{ skill: 'SQL', quote: 'Wrote SQL queries in PostgreSQL' }], missing: read[i] ?? [] })),
    };
}

test('higher_pay: pay for the CV role, better-paid adverts and what they ask that the CV lacks', async () => {
    const d = deps();
    const tool = createInsightTools(d).find((t) => t.name === 'higher_pay')!;
    const { ctx, blocks } = context();
    const out = (await tool.run({}, ctx)) as { role: string; median: number; betterPaid: Array<{ title: string }>; gaps: Array<{ skill: string; jobs: number }>; instruction: string };
    assert.deepEqual(d.asked, ['data analyst']);
    assert.equal(out.role, 'data analyst');
    assert.ok(out.median > 0);
    assert.deepEqual(out.betterPaid.map((b) => b.title).slice(0, 2), ['Analytics Engineer', 'Senior Data Analyst']);
    assert.deepEqual(out.gaps[0], { skill: 'Power BI', jobs: 2 });
    assert.ok(blocks.some((b) => b.kind === 'answerCard') && blocks.some((b) => b.kind === 'skillGaps'));
    assert.match(out.instruction, /never promise/i);
});

test('typical pay comes from adverts at their level; senior adverts are the better-paid ones, with how many employers', async () => {
    const adverts: PaidAdvert[] = [
        ...Array.from({ length: 8 }, (_, i) => ({ id: i + 1, title: 'Data Analyst', salary: `£${30 + i},000`, companyId: i % 4 })),
        { id: 40, title: 'Lead Data Analyst - Treasury', salary: 'Job Ad Salary Range: 75000 - 115000 GBP Annual', companyId: 9 },
        { id: 41, title: 'Senior Data Analyst - CRM', salary: 'Job Ad Salary Range: 60000 - 85000 GBP Annual', companyId: 9 },
        { id: 42, title: 'Data Analyst III', salary: '£52,000—£66,000', companyId: 8 },
    ];
    const tool = createInsightTools({ ...deps(), paidAdverts: async () => adverts }).find((t) => t.name === 'higher_pay')!;
    const { ctx, blocks } = context();
    const out = (await tool.run({}, ctx)) as { median: number; employers: number; betterPaid: Array<{ title: string }> };
    assert.ok(out.median >= 30_000 && out.median <= 37_000, `typical pay at their level, not pulled up by senior adverts (${out.median})`);
    assert.equal(out.employers, 4);
    assert.deepEqual(out.betterPaid.map((b) => b.title).slice(0, 3), ['Lead Data Analyst - Treasury', 'Senior Data Analyst - CRM', 'Data Analyst III'], 'higher levels first');
    assert.ok(out.betterPaid.slice(3).every((b) => b.title === 'Data Analyst'), 'then the top quarter of adverts at their own level');
    const card = blocks.find((b) => b.kind === 'answerCard') as Extract<AgentBlock, { kind: 'answerCard' }>;
    assert.match(JSON.stringify(card.pieces), /4 employers/);
});

test('too few adverts at their level: no typical figure, but what higher-level adverts pay is still shown', async () => {
    const adverts: PaidAdvert[] = [
        { id: 1, title: 'Data Analyst', salary: '£35,000', companyId: 1 },
        { id: 40, title: 'Lead Data Analyst', salary: '£95,000', companyId: 9 },
        { id: 41, title: 'Senior Data Analyst', salary: '£72,500', companyId: 9 },
    ];
    const tool = createInsightTools({ ...deps(), paidAdverts: async () => adverts }).find((t) => t.name === 'higher_pay')!;
    const { ctx, blocks } = context();
    const out = (await tool.run({}, ctx)) as { median?: number; betterPaid: Array<{ title: string; typicalPay: number }>; instruction: string };
    assert.equal(out.median, undefined);
    assert.deepEqual(out.betterPaid.map((b) => b.title), ['Lead Data Analyst', 'Senior Data Analyst']);
    assert.match(out.instruction, /no typical figure/i);
    assert.ok(blocks.some((b) => b.kind === 'answerCard'));
});

test('higher_pay without enough pay data still answers, with no figures', async () => {
    const tool = createInsightTools({ ...deps(), paidAdverts: async () => ADVERTS.slice(0, 3) }).find((t) => t.name === 'higher_pay')!;
    const out = (await tool.run({}, context().ctx)) as { error?: string; instruction: string };
    assert.equal(out.error, 'NOT_ENOUGH_PAY_DATA');
    assert.match(out.instruction, /no figure/i);
    assert.doesNotMatch(out.instruction, /ask (?:them )?(?:what|which)/i);
});

test('skill_gaps reads jobs on screen against the CV itself when they were not read yet', async () => {
    const d = deps([['Power BI'], ['Power BI', 'Azure']]);
    const tool = createInsightTools(d).find((t) => t.name === 'skill_gaps')!;
    const lastJobs: JobListCard = { query: 'Jobs in London', fromCv: true, fewCloseMatches: false, search: {}, shownIds: [1, 2], items: [1, 2].map((id) => ({ id, title: `Job ${id}`, sponsor: false, have: [], missing: [] })) };
    const { ctx, blocks } = context({ lastJobs, jobLists: [lastJobs] });
    const out = (await tool.run({}, ctx)) as { gaps: Array<{ skill: string; jobs: number }> };
    assert.deepEqual(out.gaps[0], { skill: 'Power BI', jobs: 2 });
    assert.ok(blocks.some((b) => b.kind === 'skillGaps'));
});

test('"earn more" with a CV starts higher_pay at once', () => {
    const tools = new Set(['higher_pay', 'get_cv_profile', 'search_jobs', 'salary_stats']);
    const runs = (m: string, hasCv = true) => forcedToolCalls(m, tools, { hasCv }).some((c) => c.name === 'higher_pay');
    for (const m of ['What can I improve in my resume to get more earning jobs?', 'How can I earn more?', 'how do I get a better paid job with my cv', 'I want a higher salary, what should I change in my CV?', 'higher paying jobs for me'])
        assert.equal(runs(m), true, m);
    for (const m of ['How much do data analysts earn?', 'Is £30,000 a good salary for a nurse?', 'show me more jobs'])
        assert.equal(runs(m), false, m);
    assert.equal(runs('How can I earn more?', false), false, 'without a CV the model asks for one');
});
