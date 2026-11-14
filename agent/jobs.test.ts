import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentBlock, JobListCard } from './contract';
import { newConversation, recentJobLists } from './conversations';
import { isAboutOwnCv, isJobsForMe } from './cvIntent';
import { titleFitsCode, bestFirst, bestTitleMatches, hardGapIn, levelGap, levelTitles, ownTitleFirst, pickPage, createJobExplainer, cvKeywords, cvTitlePhrases, displaySalary, jobSearchSettingsSchema, jobVerdict, jobVisaFacts, realGaps, searchJobs, type JobDetail, type JobSearchDeps, type RankRequest } from './jobs/search';
import { nextJobLists } from './jobs/lists';
import { uiPieceSchema } from './contract';
import { cardsOnlyText, asksToWrite, withSupport, withoutGuessedPay, withoutUnverifiedFigures, describesListedJob, repeatsLastAnswer, withoutBracketedCodes, withoutLicenceYes, withoutOverclaim, withoutPromise } from './agent';
import { asksAboutSoc, forcedToolCalls } from './routing';
import { createJobTools, searchSettings } from './tools/jobs';

const CV_TEXT = 'Built SQL pipelines and Power BI dashboards. Ran A/B tests on checkout changes.';
const cv = {
    version: 4,
    name: 'CV.pdf',
    hash: 'h',
    createdAt: 0,
    expiresAt: 0,
    text: CV_TEXT,
    profile: {
        headline: 'Data analyst',
        roles: [{ title: 'Data Analyst', type: 'job', start: '2022', end: '2025', evidence: 'x' }],
        education: [],
        skills: [{ name: 'Excel', source: 'skills-list', evidence: 'x' }, { name: 'SQL', source: 'experience', evidence: 'x' }],
        projects: [],
        achievements: [],
        certifications: [],
        languages: [],
        hasPersonalStatement: false,
    },
    chunks: [{ index: 0, section: 'Experience', text: CV_TEXT, embedding: [0.1, 0.2] }],
} as never;

const job = (id: number, extra: Partial<JobDetail> = {}): JobDetail => ({ id, title: `Data Analyst ${id}`, company: 'Acme', location: 'London', url: `https://jobs.example/${id}`, sponsor: false, ...extra });

function fakeDeps(over: Partial<JobSearchDeps> & { ids?: number[] } = {}): JobSearchDeps & { requests: RankRequest[] } {
    const requests: RankRequest[] = [];
    const ids = over.ids ?? [1, 2, 3];
    return {
        requests,
        rank: async (request) => {
            requests.push(request);
            return ids.map((job_id) => ({ job_id, meaning: 0.88, keyword: 0.5, seniority: null }));
        },
        details: async (list) => list.map((id) => job(id)),
        companyIds: async () => [],
        embed: async () => [0.5, 0.5],
        explain: async () => [],
        ...over,
    };
}

const signal = new AbortController().signal;
const run = (settings: object, deps: JobSearchDeps, extra: object = {}) => searchJobs(settings, { cv: cv as never, years: 3, signal, ...extra }, deps);

test('no request means the CV is the query; a named role replaces it, and the CV never does', async () => {
    const a = fakeDeps();
    const fromCv = await run({}, a);
    assert.equal(a.requests[0]!.query.length, 1);
    assert.equal(a.requests[0]!.query[0]!.v, '[0.1,0.2]');
    assert.ok(fromCv.status === 'ok' && fromCv.card.fromCv);

    const b = fakeDeps();
    const fromRole = await run({ role: 'nursing jobs' }, b);
    assert.equal(b.requests[0]!.query[0]!.v, '[0.5,0.5]', 'the request, not the CV');
    assert.deepEqual(b.requests[0]!.keywords, ['nursing']);
    assert.ok(fromRole.status === 'ok' && !fromRole.card.fromCv);
});

test('no CV and no request asks for one, instead of searching', async () => {
    const deps = fakeDeps();
    assert.equal((await searchJobs({}, { cv: null, years: null, signal }, deps)).status, 'need_cv_or_role');
    assert.equal(deps.requests.length, 0);
});

test('a role search works without any CV, and sends no years', async () => {
    const deps = fakeDeps();
    const out = await searchJobs({ role: 'data' }, { cv: null, years: null, signal }, deps);
    assert.equal(out.status, 'ok');
    assert.equal(deps.requests[0]!.cvYears, null);
});

test('filters reach the database only when given, in its own values', async () => {
    const deps = fakeDeps({ companyIds: async () => [7] });
    await run({ role: 'data', location: 'Leeds', excludeLocations: ['London'], remote: true, jobTypes: ['part-time', 'placement'], minPay: 40000, needsVisa: true, company: 'Acme', postedWithinDays: 7 }, deps);
    assert.deepEqual(deps.requests[0]!.filters, {
        location: 'Leeds',
        exclude_locations: ['London'],
        remote: true,
        job_types: ['Part-time', 'Placement scheme'],
        min_pay: 40000,
        visa: true,
        company_ids: [7],
        posted_within_days: 7,
    });
    const plain = fakeDeps();
    await run({ role: 'data' }, plain);
    assert.deepEqual(plain.requests[0]!.filters, {});
});

test('an unknown company and an empty result are reported, never filled in', async () => {
    assert.deepEqual(await run({ company: 'Nobody Ltd' }, fakeDeps()), { status: 'no_company', company: 'Nobody Ltd' });
    assert.equal((await run({ role: 'data' }, fakeDeps({ ids: [] }))).status, 'no_jobs');
    const closed = fakeDeps({ details: async () => [] });
    assert.equal((await run({ role: 'data' }, closed)).status, 'no_jobs', 'jobs without details are not shown');
});

test('a claimed skill needs a quote really in the CV; a failed explanation still shows the jobs', async () => {
    const deps = fakeDeps({
        ids: [1],
        explain: async () => [{ id: 1, summary: 'Close to your work.', have: [{ skill: 'SQL', quote: 'Built SQL pipelines' }, { skill: 'Rust', quote: 'Wrote Rust services' }, { skill: 'Go' }], missing: ['Tableau'] }],
    });
    const out = await run({}, deps);
    assert.ok(out.status === 'ok');
    assert.deepEqual(out.card.items[0]!.have.map((h) => h.skill), ['SQL']);
    assert.deepEqual(out.card.items[0]!.missing, ['Tableau']);

    const broken = await run({}, fakeDeps({ explain: async () => { throw new Error('AI down'); } }));
    assert.ok(broken.status === 'ok' && broken.card.items.length === 3 && broken.card.items[0]!.have.length === 0);
});

test('explanation is skipped when ranking was slow, so the turn does not time out', async () => {
    let explained = false;
    let clock = 0;
    const deps = fakeDeps({ rank: async () => { clock = 30_000; return [{ job_id: 1, meaning: 0.9, keyword: 0, seniority: null }]; }, explain: async () => { explained = true; return []; } });
    await run({}, deps, { now: () => clock });
    assert.equal(explained, false);
});

test('weak results say so: low CV closeness, or a role word in no title', async () => {
    const weak = await run({}, fakeDeps({ rank: async () => [{ job_id: 1, meaning: 0.85, keyword: 0, seniority: null }], details: async () => [job(1, { title: 'Head Chef' })] }));
    assert.ok(weak.status === 'ok' && weak.card.fewCloseMatches);
    const strong = await run({}, fakeDeps());
    assert.ok(strong.status === 'ok' && !strong.card.fewCloseMatches);
    const noTitle = await run({ role: 'nursing' }, fakeDeps());
    assert.ok(noTitle.status === 'ok' && noTitle.card.fewCloseMatches);
    const inTitle = await run({ role: 'data' }, fakeDeps());
    assert.ok(inTitle.status === 'ok' && !inTitle.card.fewCloseMatches);
});

test('job cards hide funding figures and unsafe links, and label the level', async () => {
    assert.equal(displaySalary('$50M–$300M'), undefined);
    assert.equal(displaySalary('£40,000'), '£40,000');
    assert.equal(displaySalary(null), undefined);
    const deps = fakeDeps({
        ids: [1],
        rank: async () => [{ job_id: 1, meaning: 0.9, keyword: 0, seniority: 'too_senior' }],
        details: async () => [job(1, { url: 'javascript:alert(1)', salary: '$50M' })],
    });
    const out = await run({}, deps);
    assert.ok(out.status === 'ok');
    assert.equal(out.card.items[0]!.url, undefined);
    assert.equal(out.card.items[0]!.salary, undefined);
    assert.match(out.card.items[0]!.levelNote!, /more experience/);
});

test('keywords put titles and work skills first and repeat nothing', () => {
    assert.deepEqual(cvKeywords(cv), ['Data Analyst', 'SQL', 'Excel']);
});

test('explainer rejects bad output without failing the search', async () => {
    const reply = (text: string) => createJobExplainer((async () => ({ ok: true, body: { candidates: [{ content: { parts: [{ text }] } }] } })) as never);
    const jobs = [job(1)];
    const each = (hash: string) => ({ ...(cv as object), hash }) as never;
    assert.deepEqual(await reply('nonsense')(each('r1'), jobs, signal), []);
    assert.deepEqual(await reply('{"jobs":"x"}')(each('r2'), jobs, signal), []);
    const good = await reply('{"jobs":[{"id":1,"summary":"Fits.","have":[{"skill":"SQL","quote":"Built SQL pipelines"}],"missing":["Tableau"]}]}')(each('r3'), jobs, signal);
    assert.equal(good[0]!.summary, 'Fits.');
    assert.deepEqual(await createJobExplainer((async () => ({ ok: false })) as never)(each('r4'), jobs, signal), []);
});

/** Records cards the way the agent shows them: one per id, a repeated id ignored unless it replaces the card in place. */
function toolCtx(extra: object = {}) {
    const blocks: AgentBlock[] = [];
    const ids: string[] = [];
    const emit = (id: string, b: AgentBlock, options: { replace?: boolean } = {}) => {
        const at = ids.indexOf(id);
        if (at < 0) {
            ids.push(id);
            blocks.push(b);
        } else if (options.replace) blocks[at] = b;
    };
    return { blocks, ctx: { uid: 'u', signal, cv: cv as never, emit, ...extra } };
}

test('job cards show before the CV reading and are then completed in place', async () => {
    const shown: Array<{ id: string; checking?: boolean; replace?: boolean; verdict?: string }> = [];
    let explained = false;
    const deps = fakeDeps({
        explain: async (_cv, jobs) => {
            explained = true;
            return jobs.map((j) => ({ id: j.id, summary: 's', have: [{ skill: 'SQL', quote: 'Built SQL pipelines' }], missing: [] }));
        },
    });
    const [search] = createJobTools(deps);
    const emit = (id: string, b: AgentBlock, options: { replace?: boolean } = {}) => {
        const card = (b as Extract<AgentBlock, { kind: 'jobList' }>).card;
        shown.push({ id, checking: card.checking, replace: options.replace, verdict: card.items[0]?.verdict?.label });
        if (!explained) assert.equal(card.checking, true, 'the first card arrives before the CV reading');
    };
    await search!.run({}, { uid: 'u', signal, cv: cv as never, emit, userMessage: 'jobs please' } as never);
    assert.deepEqual(shown.map((s) => [s.id, s.checking, s.replace]), [['job-list', true, undefined], ['job-list', undefined, true]]);
    assert.ok(shown[1]!.verdict, 'the completed card has the CV verdicts');
});

test('search_jobs shows cards, and tells the model to be honest about weak results', async () => {
    const [search] = createJobTools(fakeDeps({ rank: async () => [{ job_id: 1, meaning: 0.85, keyword: 0, seniority: null }], details: async () => [job(1, { title: 'Head Chef' })] }));
    const { blocks, ctx } = toolCtx();
    const out = (await search!.run({}, ctx)) as { count: number; fewCloseMatches: boolean; instruction: string; jobs: Array<Record<string, unknown>> };
    assert.equal(blocks[0]!.kind, 'jobList');
    assert.equal(out.fewCloseMatches, true);
    assert.match(out.instruction, /few close matches/);
    assert.equal(out.jobs[0]!.position, 1);
    assert.equal('advert' in out.jobs[0]!, false);
});

test('follow-ups: "only remote" keeps the old search, "more" skips jobs already shown', async () => {
    const deps = fakeDeps();
    const [search] = createJobTools(deps);
    const lastJobs = { query: 'q', fromCv: false, fewCloseMatches: false, search: { role: 'data', location: 'Leeds' }, shownIds: [1, 2], items: [] } as JobListCard;
    await search!.run({ refine: true, remote: true }, toolCtx({ lastJobs }).ctx);
    assert.deepEqual(deps.requests[0]!.filters, { location: 'Leeds', remote: true });
    assert.deepEqual(deps.requests[0]!.keywords, ['data']);
    const more = toolCtx({ lastJobs });
    await search!.run({ more: true }, more.ctx);
    assert.deepEqual(deps.requests[1]!.filters, { location: 'Leeds' }, 'the same request as the search itself, so its cached ranking answers');
    const shown = (more.blocks[0] as Extract<AgentBlock, { kind: 'jobList' }>).card;
    assert.deepEqual(shown.items.map((j) => j.id), [3], 'jobs already shown are skipped');
    assert.deepEqual(shown.shownIds, [1, 2, 3]);
    await search!.run({ role: 'chef' }, toolCtx({ lastJobs }).ctx);
    assert.deepEqual(deps.requests[2]!.filters, {}, 'a new search starts clean');
});

test('search_jobs reports each dead end with a next step and no cards', async () => {
    const [search] = createJobTools(fakeDeps({ ids: [] }));
    const none = toolCtx();
    assert.equal(((await search!.run({ role: 'data' }, none.ctx)) as { error: string }).error, 'NO_JOBS');
    assert.equal(none.blocks.length, 0);
    assert.equal(((await search!.run({ more: true }, toolCtx({ lastJobs: { search: {}, shownIds: [1], items: [] } }).ctx)) as { error: string }).error, 'NO_MORE_JOBS');
    assert.equal(((await search!.run({}, toolCtx({ cv: null }).ctx)) as { error: string }).error, 'NEED_CV_OR_ROLE');
});

test('a person with undated roles gets no level check rather than a wrong one', async () => {
    const deps = fakeDeps();
    const [search] = createJobTools(deps);
    const undated = { ...(cv as object), profile: { ...(cv as { profile: object }).profile, roles: [{ title: 'Analyst', type: 'job', evidence: 'x' }] } };
    await search!.run({}, toolCtx({ cv: undated }).ctx);
    assert.equal(deps.requests[0]!.cvYears, null);
    await search!.run({ refine: false }, toolCtx().ctx);
    assert.equal(typeof deps.requests[1]!.cvYears, 'number');
});

test('job_details reads the right job and handles closed or unknown ones', async () => {
    const [, details] = createJobTools(fakeDeps({ details: async (ids) => ids.filter((i) => i !== 9).map((i) => job(i, { description: 'x'.repeat(9000), salary: '$50M' })) }));
    const lastJobs = { items: [{ id: 5 }, { id: 9 }] };
    const ok = (await details!.run({ position: 1 }, toolCtx({ lastJobs }).ctx)) as { title: string; advert: string; salary?: string };
    assert.equal(ok.title, 'Data Analyst 5');
    assert.equal(ok.advert.length, 8000);
    assert.equal(ok.salary, undefined);
    assert.equal(((await details!.run({ position: 2 }, toolCtx({ lastJobs }).ctx)) as { error: string }).error, 'JOB_CLOSED');
    assert.equal(((await details!.run({ position: 3 }, toolCtx({ lastJobs }).ctx)) as { error: string }).error, 'NO_SUCH_JOB');
    assert.equal(((await details!.run({}, toolCtx().ctx)) as { error: string }).error, 'NO_SUCH_JOB');
});

test('job requests for the CV are recognised; other job questions are not', () => {
    for (const message of ['Give me jobs for my CV', 'Give me jobs matching my cv', 'jobs for me', 'roles that suit me', 'Find me a job', 'show me jobs', 'any jobs based on my experience?', 'positions that fit my background']) {
        assert.ok(isJobsForMe(message), message);
        assert.ok(isAboutOwnCv(message), `${message}: a CV is needed`);
    }
    for (const message of ['Give me nursing jobs', 'What does a data analyst do?', 'Find me a nursing job in Leeds', 'What jobs are in demand in the UK?', 'how do I write a CV for a job?', 'hi']) {
        assert.equal(isJobsForMe(message), false, message);
    }
});

test('job_fit compares one job with the CV, keeps only real quotes, and handles dead ends', async () => {
    const [, , fit] = createJobTools(
        fakeDeps({
            details: async () => [job(5, { description: 'Needs SQL and Rust. '.repeat(600) })],
            explain: async () => [{ id: 5, summary: 'Close on data, short on Rust.', have: [{ skill: 'SQL', quote: 'Built SQL pipelines' }, { skill: 'Go', quote: 'Wrote Go services' }], missing: ['Rust'] }],
        }),
    );
    const lastJobs = { items: [{ id: 5 }] };
    const out = (await fit!.run({ position: 1 }, toolCtx({ lastJobs }).ctx)) as { matches: Array<{ skill: string }>; missing: string[]; summary: string; advert: string; yearsOfPaidExperience: number };
    assert.deepEqual(out.matches.map((m) => m.skill), ['SQL']);
    assert.deepEqual(out.missing, ['Rust']);
    assert.equal(out.advert.length, 8000);
    assert.equal(typeof out.yearsOfPaidExperience, 'number');
    assert.equal(((await fit!.run({ position: 2 }, toolCtx({ lastJobs }).ctx)) as { error: string }).error, 'NO_SUCH_JOB');
    assert.equal(((await fit!.run({ position: 1 }, toolCtx({ lastJobs, cv: null }).ctx)) as { error: string }).error, 'NEED_CV');
    const [, , closed] = createJobTools(fakeDeps({ details: async () => [] }));
    assert.equal(((await closed!.run({ position: 1 }, toolCtx({ lastJobs }).ctx)) as { error: string }).error, 'JOB_CLOSED');
    const [, , aiDown] = createJobTools(fakeDeps({ explain: async () => { throw new Error('down'); } }));
    assert.deepEqual(((await aiDown!.run({ position: 1 }, toolCtx({ lastJobs }).ctx)) as { matches: unknown[] }).matches, [], 'the advert is still there to answer from');
});

test('a long explanation list is cut, not thrown away', async () => {
    const have = Array.from({ length: 9 }, (_, i) => ({ skill: `S${i}`, quote: 'Built SQL pipelines' }));
    const explain = createJobExplainer((async () => ({ ok: true, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ jobs: [{ id: 1, have, missing: [] }] }) }] } }] } })) as never);
    assert.equal((await explain({ ...(cv as object), hash: 'long-list' } as never, [job(1)], signal))[0]!.have!.length, 6);
});

test('a short CV with matching titles is not called a weak result', async () => {
    const low = { rank: async () => [{ job_id: 1, meaning: 0.85, keyword: 0, seniority: null }] };
    const named = await run({}, fakeDeps(low));
    assert.ok(named.status === 'ok' && !named.card.fewCloseMatches, 'Data Analyst CV, Data Analyst job');
    const other = await run({}, fakeDeps({ ...low, details: async () => [job(1, { title: 'Head Chef' })] }));
    assert.ok(other.status === 'ok' && other.card.fewCloseMatches);
});

test('job cards carry stored SOC and visa facts with official figures, marked as estimates when unsure', () => {
    const facts = jobVisaFacts(job(1, { soc_code: '2134', soc_confidence: 'high', sponsorship_outcome: 'eligible', sponsorship_reasons: [{ text: 'Matches an eligible occupation.' }], salary_check: 'meets', sponsorship_list_as_of: '2026-10-20' }))!;
    assert.equal(facts.soc.sure, true);
    assert.equal(facts.soc.title, 'Programmers and software development professionals');
    assert.equal(facts.generalThreshold, 54700);
    assert.equal(facts.newEntrantThreshold, 38300);
    assert.match(facts.newApplicants, /Open to new/);
    assert.equal(facts.payCheck, 'meets');
    const legacy = jobVisaFacts(job(2, { soc_code: '8215', soc_confidence: 'low', sponsorship_outcome: 'not_sure', soc_alternatives: [{ code: '8215', share: 0.5 }, { code: '3574', share: 0.3 }, { code: '2134', share: 0.01 }, { code: '9999', share: 0.4 }], salary_check: 'not_stated' }))!;
    assert.equal(legacy.soc.sure, false);
    assert.deepEqual(legacy.otherSoc.map((o) => o.code), ['3574'], 'real, close alternatives only');
    assert.match(legacy.newApplicants, /Not normally/);
    assert.match(legacy.existingHolders, /before 22 July 2025/);
    assert.equal(legacy.payCheck, undefined);
    assert.equal(facts.goingRate, 54700);
    assert.equal(facts.goingRateHourly, 28.05);
    assert.deepEqual(facts.options.map((o) => o.option), ['A', 'B', 'C', 'E', 'F', 'G', 'H', 'J']);
    assert.equal(facts.options[0]!.hourly, 28.05);
    assert.equal(facts.phdEligible, true);
    assert.deepEqual(facts.routes, ['Skilled Worker', 'Global Business Mobility', 'Scale-up']);
    assert.equal(facts.jobTitles.length, 30);
    assert.ok(facts.moreJobTitles > 0);
    const sureWithOthers = jobVisaFacts(job(5, { soc_code: '2134', soc_confidence: 'high', sponsorship_outcome: 'eligible', soc_alternatives: [{ code: '2136', share: 0.2 }] }))!;
    assert.deepEqual(sureWithOthers.otherSoc.map((o) => o.code), ['2136'], 'close codes show even when sure');
    assert.ok(jobVisaFacts(job(6, { soc_code: '2211', soc_confidence: 'high', sponsorship_outcome: 'eligible' }))!.payScales!.length > 0, 'pay scale codes');
    assert.ok(jobVisaFacts(job(7, { soc_code: '1212', soc_confidence: 'high', sponsorship_outcome: 'not_sure' }))!.salaryList!.length > 0, 'salary list codes');
    assert.equal(jobVisaFacts(job(3)), undefined, 'no stored assessment, nothing shown');
    assert.equal(jobVisaFacts(job(4, { soc_code: '9999', sponsorship_outcome: 'eligible' })), undefined, 'unknown code');
});

test('a SOC or visa question about a listed job gets the stored facts, not the advert', async () => {
    const stored = { soc_code: '2134', soc_confidence: 'high', sponsorship_outcome: 'eligible', description: 'An advert.' };
    const [, details] = createJobTools(fakeDeps({ details: async () => [job(5, stored)] }));
    const lastJobs = { items: [{ id: 5 }] };
    const soc = (await details!.run({ position: 1 }, toolCtx({ lastJobs, userMessage: 'What SOC code and visa rules apply to job 1?' }).ctx)) as { visa: { soc: { code: string } }; advert?: string };
    assert.equal(soc.visa.soc.code, '2134');
    assert.equal(soc.advert, undefined);
    const shown = toolCtx({ lastJobs, userMessage: 'SOC for job 1?' });
    await details!.run({ position: 1 }, shown.ctx);
    const facts = shown.blocks.find((b) => b.kind === 'officialFacts') as Extract<AgentBlock, { kind: 'officialFacts' }>;
    assert.equal(facts.card.facts.find((f) => f.label === 'Going rate')!.value, '£54,700', 'the full official card for that code');
    assert.ok(facts.card.details!.jobTitles.length > 30);
    const plain = (await details!.run({ position: 1 }, toolCtx({ lastJobs, userMessage: 'Tell me about job 1' }).ctx)) as { advert?: string };
    assert.equal(plain.advert, 'An advert.');
    const [, none] = createJobTools(fakeDeps({ details: async () => [job(5)] }));
    assert.match(((await none!.run({ position: 1 }, toolCtx({ lastJobs, userMessage: 'SOC for job 1?' }).ctx)) as { instruction: string }).instruction, /no SOC or visa assessment/);
});

test('general questions do not need a CV; pay for a named code goes straight to its figures', () => {
    for (const m of ['How do I become a data analyst with no experience?', 'how do i get experience in marketing']) assert.equal(isAboutOwnCv(m), false, m);
    for (const m of ['Do I have enough experience for this role?', 'Am I qualified?']) assert.ok(isAboutOwnCv(m), m);
    const can = new Set(['visa_salary_rules', 'soc_lookup']);
    assert.deepEqual(forcedToolCalls('What is the going rate for SOC 2134?', can), [{ name: 'visa_salary_rules', args: { socCode: '2134' } }]);
    assert.deepEqual(forcedToolCalls('What is SOC 2134?', can), []);
    assert.ok(asksAboutSoc('What is the new entrant salary for a nurse?'));
    assert.deepEqual(forcedToolCalls('What is the new entrant salary for a nurse?', can), [{ name: 'soc_lookup', args: { query: 'nurse' } }]);
});

test('visa figures never reach a question about pay, and a slow search says so', async () => {
    const stored = { soc_code: '2134', soc_confidence: 'high', sponsorship_outcome: 'eligible', description: 'An advert.', salary: 'Competitive' };
    const [search, details, fit] = createJobTools(fakeDeps({ details: async () => [job(5, stored)] }));
    const lastJobs = { items: [{ id: 5 }] };
    const plain = (await details!.run({ position: 1 }, toolCtx({ lastJobs, userMessage: 'What is the salary for this job?' }).ctx)) as Record<string, unknown>;
    assert.equal(plain.visa, undefined);
    assert.equal(plain.salary, undefined);
    assert.equal(((await fit!.run({ position: 1 }, toolCtx({ lastJobs }).ctx)) as Record<string, unknown>).visa, undefined);
    assert.doesNotMatch(JSON.stringify(plain), /54,?700/);
    void search;
    const [slow] = createJobTools(fakeDeps({ rank: async () => { throw new Error('timed out'); } }));
    const out = (await slow!.run({}, toolCtx().ctx)) as { error: string; instruction: string };
    assert.equal(out.error, 'SEARCH_SLOW');
    assert.match(out.instruction, /Never say a tool is unavailable/);
});

test('jobs carrying the CV\'s own job title come first, only for a plain CV search', async () => {
    const careCv = { ...(cv as object), profile: { ...(cv as { profile: object }).profile, roles: [{ title: 'Senior Care Worker' }, { title: 'Graduate Trainee' }] } } as never;
    assert.deepEqual(cvTitlePhrases(careCv), ['care worker']);
    const changer = { ...(cv as object), profile: { ...(cv as { profile: object }).profile, headline: 'Former logistics manager, now a junior software developer.', roles: [{ title: 'Logistics Manager' }] } } as never;
    assert.deepEqual(cvTitlePhrases(changer), [], 'an old career is not searched for');
    const asked: string[][] = [];
    const term = cvKeywords(careCv)[0]!;
    const titled = [{ id: 9, title: 'Care Worker', description: `Uses ${term}` }, { id: 2, title: 'Care Worker', description: `Also ${term}` }];
    const deps = fakeDeps({ ids: [1, 2, 3], titleJobs: async (phrases) => { asked.push(phrases); return titled; } });
    const signal = new AbortController().signal;
    const out = await searchJobs({}, { cv: careCv, years: 5, signal }, { ...deps, explain: async () => [] });
    assert.equal(out.status, 'ok');
    const ids = (out as Extract<typeof out, { status: 'ok' }>).card.items.map((job) => job.id);
    assert.deepEqual(ids.slice(0, 2), [9, 2]);
    assert.equal(ids.length, new Set(ids).size, 'no job twice');
    await searchJobs({ remote: true }, { cv: careCv, years: 5, signal }, { ...deps, explain: async () => [] });
    await searchJobs({ role: 'chef' }, { cv: careCv, years: 5, signal }, { ...deps, explain: async () => [] });
    assert.equal(asked.length, 1, 'a filter or a named role keeps its own results');
    const failed = await searchJobs({}, { cv: careCv, years: 5, signal }, { ...deps, explain: async () => [], titleJobs: async () => { throw new Error('down'); } });
    assert.equal(failed.status, 'ok', 'a failed lookup never loses the search');
});

test('a shared title is not enough: the CV\'s field and level decide', () => {
    const base = (cv as { profile: object }).profile;
    const builder = { ...(cv as object), profile: { ...base, headline: 'Senior Project Manager in construction', roles: [{ title: 'Senior Project Manager' }] } } as never;
    const jobs = [{ id: 1, title: 'Project Manager (Marketing)', description: 'campaigns' }, { id: 2, title: 'Project Manager', description: 'Construction sites and contractors' }];
    assert.deepEqual(bestTitleMatches(jobs, builder, 20), [2], 'other fields drop out');
    const intern = { ...(cv as object), profile: { ...base, headline: 'Data science student', roles: [{ title: 'Data Analyst Intern' }] } } as never;
    const term = cvKeywords(intern)[0] ?? 'data science';
    const levels = [{ id: 3, title: 'Senior Data Analyst', description: `data science ${term}` }, { id: 4, title: 'Data Analyst', description: `data science ${term}` }];
    assert.deepEqual(bestTitleMatches(levels, intern, 0.3), [4], 'senior posts drop out for a beginner');
    assert.deepEqual(bestTitleMatches(levels, intern, 8), [3, 4], 'and stay for someone experienced');
});

test('a page has variety and puts clear level gaps last, without ever hiding a job for good', () => {
    const jobs: Record<number, { title: string; company: string }> = {
        1: { title: 'Civil Engineer', company: 'AECOM' }, 2: { title: 'Senior Civil Engineer', company: 'AECOM' }, 3: { title: 'Graduate Civil Engineer', company: 'AECOM' }, 4: { title: 'Civil Engineer', company: 'Arup' },
    };
    const about = (id: number) => jobs[id];
    const rows = [1, 2, 3, 4].map((job_id) => ({ job_id }));
    assert.deepEqual(pickPage(rows, about, { limit: 3 }).map((r) => r.job_id), [1, 2, 4], 'a third from one company waits');
    assert.deepEqual(pickPage(rows, about, { limit: 4 }).map((r) => r.job_id), [1, 2, 4, 3], 'and still fills the page');
    const reposts: Record<number, { title: string; company: string }> = { 1: { title: 'DevOps & Cloud Engineer - HR Tech', company: 'Acme' }, 2: { title: 'DevOps and cloud engineer – HR tech', company: 'Acme' }, 3: { title: 'DevOps Engineer', company: 'Beta' } };
    assert.deepEqual(pickPage([1, 2, 3].map((job_id) => ({ job_id })), (id) => reposts[id], { limit: 2 }).map((r) => r.job_id), [1, 3], 'the same job advertised twice takes one place');
    assert.deepEqual(pickPage([1, 2, 3].map((job_id) => ({ job_id })), (id) => reposts[id], { limit: 3 }).map((r) => r.job_id), [1, 3, 2], 'and fills the page only when nothing else is left');
    assert.equal(levelGap('Executive Chef', ['Sous Chef'], 7), true);
    assert.equal(levelGap('Head Chef', ['Sous Chef'], 7), false, 'one step up is a normal next job');
    assert.equal(levelGap('Deputy Director of Continuing Care', ['Senior Care Worker'], 5), true);
    assert.equal(levelGap('Director of Finance', ['Finance Director'], 15), false);
    assert.equal(levelGap('Principal Full Stack Engineer', ['Logistics Manager'], 10), false, 'manager to principal is one step');
    assert.equal(levelGap('Principal Engineer', ['Bootcamp Student'], 0), true);
    assert.equal(levelGap('Teaching Assistant', ['Teacher of Mathematics'], 7), true);
    assert.equal(levelGap('Teaching Assistant', ['Teaching Assistant'], 7), false);
    assert.equal(levelGap('Junior Developer', ['Developer'], 1), false);
    assert.equal(levelGap('Senior Data Analyst', ['Data Analyst Intern'], 0.3), true, 'senior is two steps from an intern');
    const changer = { ...(cv as object), profile: { ...(cv as { profile: object }).profile, headline: 'Former logistics manager, now a junior software developer.', roles: [{ title: 'Logistics Manager' }] } } as never;
    assert.deepEqual(levelTitles(changer), ['junior software developer.']);
    assert.equal(levelGap('Senior Software Engineer', levelTitles(changer), 10), true, 'old manager years do not make a new starter senior');
});

test('jobs with the same title as the CV come before any other', () => {
    assert.deepEqual(ownTitleFirst([{ id: 1 }, { id: 2 }, { id: 3 }], [3, 2]).map((job) => job.id), [2, 3, 1]);
    assert.deepEqual(ownTitleFirst([{ id: 1 }, { id: 2 }], []).map((job) => job.id), [1, 2]);
});

test('a stored SOC code that shares no real word with the job title is only a possible code', () => {
    assert.equal(titleFitsCode('Platter Team Member', '2134'), false);
    // GOV.UK lists "Head of digital transformation" under 1137, so a transformation lead does share a real word with it.
    assert.equal(titleFitsCode('Lean Transformation Lead', '1137'), true);
    assert.equal(titleFitsCode('Software Engineer', '2134'), true);
    assert.equal(titleFitsCode('Staff Nurse', '2237'), true);
    assert.equal(titleFitsCode('Civil Engineer', '2121'), true);
    const odd = jobVisaFacts(job(1, { title: 'Platter Team Member', soc_code: '2134', soc_confidence: 'high', sponsorship_outcome: 'eligible' }))!;
    assert.equal(odd.soc.sure, false);
});

test('a job card does not contradict its own label', () => {
    const shortage = jobVisaFacts(job(1, { soc_code: '3544', soc_confidence: 'high', sponsorship_outcome: 'eligible', sponsorship_route: 'temporary_shortage_list' }))!;
    assert.match(shortage.newApplicants, /Temporary Shortage List/);
    assert.doesNotMatch(shortage.newApplicants, /^Not normally/);
});

test('SOC codes only come up when the talk is about SOC codes or visas', () => {
    for (const message of ['Give me jobs for my CV', 'What kind of roles are you looking for?', 'Find me a job', 'Summarise my CV']) assert.equal(asksAboutSoc(message), false, message);
    for (const message of ['Which SOC code fits my CV?', 'Is a chef eligible for a Skilled Worker visa?', 'Can this employer sponsor me?', 'What is the going rate?', 'Can I come to the UK as a chef?', 'I want to move to England as a nurse']) assert.ok(asksAboutSoc(message), message);
    assert.ok(asksAboutSoc('What about my CV?', ['Here are the SOC codes for a nurse.']), 'a follow-up keeps the topic');
});

test('code decides the verdict from facts, and the AI cannot call a stretch a good match', () => {
    const years = { years: 1.5 };
    assert.equal(jobVerdict({ advert: 'Needs 3+ years of backend experience.', have: 4, missing: 0, ...years }).label, 'stretch');
    assert.match(jobVerdict({ advert: 'Needs 3+ years of backend experience.', have: 4, missing: 0, ...years }).reason, /3\+ years.*1\.5/);
    assert.equal(jobVerdict({ advert: 'Needs 2 years of experience.', have: 3, missing: 0, ...years }).label, 'close');
    assert.equal(jobVerdict({ advert: '', have: 3, missing: 1, ...years }).label, 'close');
    assert.equal(jobVerdict({ advert: '', have: 1, missing: 3, ...years }).label, 'possible');
    assert.equal(jobVerdict({ advert: '', have: 0, missing: 0, ...years }).label, 'stretch');
    assert.equal(jobVerdict({ advert: '', have: 4, missing: 1, hardGap: 'Spring 2028 graduation date', ...years }).label, 'possible', 'a condition can rule a job out');
    assert.match(jobVerdict({ advert: '', have: 4, missing: 1, hardGap: 'SC clearance', ...years }).reason, /SC clearance/);
    assert.equal(hardGapIn(['GraphQL', 'SC clearance']), 'SC clearance');
    assert.equal(hardGapIn(['GraphQL', 'Kafka']), undefined);
    assert.equal(jobVerdict({ advert: '', have: 3, missing: 0, years: 1, tooSenior: true }).label, 'stretch');
    assert.equal(jobVerdict({ advert: 'Needs 9 years of experience.', have: 2, missing: 0, years: null }).label, 'close', 'no dates: no years check');

    const stretch = JSON.stringify([{ result: { verdict: { label: 'stretch' } } }]);
    assert.equal(withoutOverclaim('This is a perfect match. It asks for 3 years.', stretch), 'It asks for 3 years.');
    assert.equal(withoutOverclaim('A strong fit for you. It asks for PHP.', JSON.stringify([{ label: 'possible' }])), 'It asks for PHP.');
    assert.equal(withoutOverclaim('A good match.', JSON.stringify([{ label: 'close' }])), 'A good match.');
    assert.equal(withoutOverclaim('A good match.', '[]'), 'A good match.', 'no verdict in play');
});

test('the same job read twice for the same CV gets the same answer, without a second AI call', async () => {
    let calls = 0;
    const explain = createJobExplainer((async () => {
        calls++;
        return { ok: true, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ jobs: [{ id: 41, summary: 'First reading.', have: [], missing: [] }] }) }] } }] } };
    }) as never);
    const sameCv = { ...(cv as object), hash: 'remember-test' } as never;
    assert.equal((await explain(sameCv, [job(41)], signal))[0]!.summary, 'First reading.');
    assert.equal((await explain(sameCv, [job(41)], signal))[0]!.summary, 'First reading.');
    assert.equal(calls, 1);
    await explain({ ...(cv as object), hash: 'another-cv' } as never, [job(41)], signal);
    assert.equal(calls, 2, 'another CV is read on its own');
});

test('nothing carries over that the user did not say', async () => {
    const dev = { profile: { headline: 'Lean Trainer and Consultant', roles: [{ title: 'Lean Trainer and Consultant' }] } } as never;
    const set = (over: object) => searchSettings({ args: {}, message: '', cv: null, ...over });
    assert.deepEqual(set({ args: { role: 'data analyst', location: 'London' }, message: 'mujhe data analyst ki naukri chahiye' }), { role: 'data analyst' }, 'a city nobody named this time');
    assert.deepEqual(set({ args: { role: 'chef', location: 'London' }, message: 'chef jobs in londn' }), { role: 'chef', location: 'London' }, 'a typo still names it');
    assert.deepEqual(set({ refine: true, args: { remote: true }, previous: { role: 'data', location: 'Leeds' }, message: 'only remote' }), { role: 'data', location: 'Leeds', remote: true });
    assert.deepEqual(set({ args: { role: 'Lean Trainer and Consultant' }, message: 'give me jobs', cv: dev }), {}, 'their own title is not a request');
    assert.deepEqual(set({ args: { role: 'lean' }, message: 'lean jobs please', cv: dev }), { role: 'lean' }, 'unless they asked for it');
    const deps = fakeDeps();
    const [search, , , recommend] = createJobTools(deps);
    await search!.run({ role: 'data', location: 'London' }, toolCtx({ userMessage: 'ok jobs for my cv again' }).ctx);
    assert.deepEqual(deps.requests[0]!.filters, {}, 'back to the CV');
    assert.equal(deps.requests[0]!.query[0]!.v, '[0.1,0.2]');
    const list = { query: 'q', search: {}, shownIds: [], items: [{ id: 1, title: 'A', sponsor: false, have: [], missing: [] }] };
    // "Jobs for my CV" reaching the wrong tool still shows the list, so the words never arrive without the cards.
    const wantsList = toolCtx({ lastJobs: list, userMessage: 'give me jobs for my cv' });
    assert.equal(((await recommend!.run({ count: 1 }, wantsList.ctx)) as { error?: string }).error, undefined);
    assert.ok(wantsList.blocks.some((b) => b.kind === 'jobList' && !b.card.pick), 'the full list shows');
    const onePick = toolCtx({ lastJobs: list, userMessage: 'give me the one best job for my cv' });
    await recommend!.run({ count: 1 }, onePick.ctx);
    assert.ok(onePick.blocks.some((b) => b.kind === 'jobList' && b.card.pick && b.card.shortlist), 'one job is a recommendation');
    assert.equal(withoutPromise('You can apply confidently for this role. It asks for React.'), 'It asks for React.');
    assert.equal(withoutPromise('You will definitely get it. Check the advert.'), 'Check the advert.');
    assert.equal(withoutPromise('I cannot say you will definitely get a visa.'), 'I cannot say you will definitely get a visa.');
});

test('stating a listed job from memory sends the model back to read it; other jobs do not', () => {
    const lists = [{ items: [{ id: 1, title: 'Full Stack Engineer', company: 'XYZ Reality' }] }] as never;
    assert.ok(describesListedJob('The Full Stack Engineer role at XYZ Reality requires AWS and Docker.', lists));
    assert.ok(describesListedJob('The Full Stack Engineer role at XYZ Reality is a good option.', lists));
    assert.equal(describesListedJob('Glad I could help with the Full Stack Engineer role at XYZ Reality!', lists), false, 'no fact stated');
    assert.equal(describesListedJob('Backend roles usually require SQL.', lists), false, 'not a listed job');
    assert.equal(describesListedJob('The Full Stack Engineer at Acme requires Go.', lists), false, 'another company');
});

test('recommend_jobs leaves out the jobs they do not want', async () => {
    const [, , , recommend] = createJobTools(fakeDeps({ explain: async () => [] }));
    const list = { query: 'q', search: {}, shownIds: [], items: [{ id: 6, title: 'A', sponsor: false, have: [], missing: [] }, { id: 7, title: 'B', sponsor: false, have: [], missing: [] }] };
    const out = (await recommend!.run({ count: 1, exclude: [1] }, toolCtx({ lastJobs: list }).ctx)) as { jobs: Array<{ title: string }> };
    assert.equal(out.jobs[0]!.title, 'B');
    assert.equal(((await recommend!.run({ count: 1, exclude: [1, 2] }, toolCtx({ lastJobs: list }).ctx)) as { error: string }).error, 'NO_MORE_JOBS');
});

test('repeating the last answer is caught; a similar start is not', () => {
    const history = [{ role: 'assistant', text: 'The advert for the Junior Software Engineer role at Mytos does not state a salary.' }] as never;
    assert.ok(repeatsLastAnswer('The advert for the Junior Software Engineer role at Mytos does not state a salary. It says competitive.', history));
    assert.equal(repeatsLastAnswer('The Junior Software Engineer role at Mytos is a close match.', history), false);
    assert.equal(repeatsLastAnswer('Hello there.', history), false);
    assert.equal(repeatsLastAnswer('Anything at all goes here for this test ok then yes', [] as never), false);
});

test('"will X sponsor me" keeps the licence fact without a Yes', () => {
    assert.equal(withoutLicenceYes('Yes, Google holds a licence.', 'Will Google sponsor me?'), 'Google holds a licence.');
    assert.equal(withoutLicenceYes('Yes, Google holds a licence.', 'Does Google hold a licence?'), 'Yes, Google holds a licence.');
});

test('filters alone are a request; the job asked about shows its card and link', async () => {
    const deps = fakeDeps();
    const out = await searchJobs({ location: 'Manchester', jobTypes: ['part-time'] }, { cv: null, years: null, signal }, deps);
    assert.equal(out.status, 'ok');
    assert.deepEqual(deps.requests[0]!.filters, { location: 'Manchester', job_types: ['Part-time'] });
    assert.equal((await searchJobs({}, { cv: null, years: null, signal }, fakeDeps())).status, 'need_cv_or_role');
    const list = { query: 'q', search: {}, shownIds: [], items: [{ id: 5, title: 'A', sponsor: false, have: [], missing: [] }] };
    const [, details, fit] = createJobTools(fakeDeps({ details: async () => [job(5)] }));
    const one = toolCtx({ lastJobs: list, userMessage: 'job link for that' });
    await details!.run({ position: 1 }, one.ctx);
    assert.equal((one.blocks[0] as Extract<AgentBlock, { kind: 'jobList' }>).card.items[0]!.id, 5);
    const two = toolCtx({ lastJobs: list });
    await fit!.run({ position: 1 }, two.ctx);
    assert.equal((two.blocks[0] as Extract<AgentBlock, { kind: 'jobList' }>).card.pick, true);
});

test('an earlier number does not carry into "jobs for my CV"', async () => {
    const [search] = createJobTools(fakeDeps());
    const one = toolCtx({ userMessage: 'give me jobs for my cv' });
    await search!.run({ count: 1 }, one.ctx);
    assert.equal(one.blocks.length, 1);
    assert.equal((one.blocks[0] as Extract<AgentBlock, { kind: 'jobList' }>).card.hidden, undefined, 'the full list shows');
    const best = toolCtx({ userMessage: 'give me the one best job for my cv' });
    await search!.run({ count: 1 }, best.ctx);
    assert.ok(best.blocks.some((b) => b.kind === 'jobList' && b.card.pick));
});

test('after a recommendation, job numbers mean the jobs just shown; other numbers stay put', () => {
    const items = [1, 2, 3, 4, 5].map((id) => ({ id, title: `Job ${id}`, sponsor: false, have: [], missing: [] }));
    const card = { query: 'q', fromCv: true, fewCloseMatches: false, search: {}, shownIds: [], items };
    const pick = { ...card, pick: true, shortlist: true, items: [items[0]!, items[3]!] };
    const [lists] = [nextJobLists([], [{ kind: 'jobList', card: { ...card, hidden: true } }, { kind: 'jobList', card: pick }] as never)];
    assert.deepEqual(lists[0]!.items.map((j) => j.id), [1, 4, 3, 2, 5]);
    assert.deepEqual(lists[0]!.recommendedIds, [1, 4]);
    const viewing = { ...card, pick: true, items: [items[4]!] };
    assert.deepEqual(nextJobLists([card] as never, [{ kind: 'jobList', card: viewing }] as never)[0]!.items.map((j) => j.id), [1, 2, 3, 4, 5], 'reading one job changes no numbers');
    const newer = { ...card, query: 'new', items: [items[2]!] };
    assert.equal(nextJobLists(lists, [{ kind: 'jobList', card: newer }] as never)[0]!.query, 'new');
});

test('"another one" does not offer a recommended job again', async () => {
    const items = [1, 2, 3].map((id) => ({ id, title: `Job ${id}`, sponsor: false, have: [], missing: [] }));
    const [, , , recommend] = createJobTools(fakeDeps({ details: async (ids: number[]) => ids.map((id) => job(id)) }));
    const asked = toolCtx({ lastJobs: { query: 'q', search: {}, shownIds: [], recommendedIds: [1], items } as never, userMessage: 'give me another one' });
    await recommend!.run({ count: 1 }, asked.ctx);
    const shown = asked.blocks.find((b) => b.kind === 'jobList') as Extract<AgentBlock, { kind: 'jobList' }>;
    assert.notEqual(shown.card.items[0]!.id, 1);
});

test('"jobs for my CV" drops old filters but keeps what this message names', async () => {
    const deps = fakeDeps();
    const [search] = createJobTools(deps);
    await search!.run({ role: 'data', refine: true }, toolCtx({ userMessage: 'ok jobs for my cv again', lastJobs: { query: 'data', search: { role: 'data', location: 'Leeds' }, shownIds: [], items: [] } as never }).ctx);
    assert.deepEqual(deps.requests[0]!.filters, {}, 'refine true does not bring the old search back');
    await search!.run({ location: 'Leeds' }, toolCtx({ userMessage: 'Jobs that fit my experience in Leeds' }).ctx);
    assert.deepEqual(deps.requests[1]!.filters, { location: 'Leeds' });
});

test('job numbers read the newest list unless an older one is named', async () => {
    const newest = { query: 'Jobs for your CV (remote)', search: {}, shownIds: [], items: [{ id: 7, title: 'New', sponsor: false, have: [], missing: [] }] };
    const older = { query: 'chef jobs', search: {}, shownIds: [], items: [{ id: 8, title: 'Old', sponsor: false, have: [], missing: [] }] };
    const [, details] = createJobTools(fakeDeps({ details: async (ids: number[]) => ids.map((id) => job(id)) }));
    const asked = async (userMessage: string) => { const c = toolCtx({ lastJobs: newest as never, jobLists: [newest, older] as never, userMessage }); await details!.run({ position: 1, list: 1 }, c.ctx); return (c.blocks[0] as Extract<AgentBlock, { kind: 'jobList' }>).card.items[0]!.id; };
    assert.equal(await asked('compare job 1 and job 2'), 7);
    assert.equal(await asked('job 1 from the list before'), 8);
    assert.equal(await asked('job 1 from the chef list'), 8);
});

test('spoken job types are accepted; an apprentice is never surely a director', () => {
    assert.deepEqual(jobSearchSettingsSchema.parse({ jobTypes: ['Part time', 'internships'] }).jobTypes, ['part-time', 'internship']);
    assert.equal(jobSearchSettingsSchema.safeParse({ jobTypes: ['whenever'] }).success, false);
    const facts = (title: string, code: string) => jobVisaFacts(job(1, { title, soc_code: code, soc_confidence: 'high', sponsorship_outcome: 'not_sure' }))!.soc.sure;
    assert.equal(facts('Insurance Apprenticeship Programme', '1131'), false);
    assert.equal(facts('Finance Director', '1131'), true);
    assert.equal(facts('Graduate Software Engineer', '2134'), true);
});

test('a written request is recognised; cards alone still name the list', () => {
    assert.ok(asksToWrite('write a cover letter for job 1'));
    assert.ok(asksToWrite('Can you draft an email to the recruiter'));
    assert.equal(asksToWrite('what should a cover letter include'), false);
    assert.equal(asksToWrite('How do I write a cover letter?'), false);
    const card = { query: 'Jobs for your CV (remote)', search: {}, shownIds: [], items: [{ id: 1 }, { id: 2 }] };
    assert.match(cardsOnlyText([{ kind: 'jobList', card }] as never), /2 jobs: Jobs for your CV \(remote\)/);
    assert.match(cardsOnlyText([{ kind: 'socCards' }] as never), /Here is what I found/);
});

test('someone in despair always sees where to get help; ordinary wording does not trigger it', () => {
    assert.match(withSupport('I am sorry.', 'I feel like giving up, I cannot go on'), /Samaritans.*116 123/);
    assert.match(withSupport('I am sorry.', 'i want to kill myself'), /116 123/);
    assert.equal(withSupport('Call Samaritans.', 'I feel hopeless'), 'Call Samaritans.');
    assert.equal(withSupport('Fine.', 'should I give up my job for a masters'), 'Fine.');
    assert.equal(withSupport('Fine.', 'I cannot go on Tuesday'), 'Fine.', 'needs the words together');
});

test('a remembered pay figure is dropped; one from a tool or the message stays', () => {
    const answer = (text: string) => ({ text, pieces: [], suggestions: [] });
    const guess = withoutGuessedPay(answer('It varies. Many start at £25,000 to £35,000. Ask me for jobs.'), 'how much do analysts earn', 'how much do analysts earn');
    assert.ok(!guess.text.includes('£'));
    assert.match(guess.text, /will not guess/);
    assert.ok(!withoutGuessedPay(answer('Maybe £30k.'), 'what do analysts earn', 'x').text.includes('£'));
    assert.equal(withoutGuessedPay(answer('The advert says £40,000.'), 'what is the salary for job 1', 'salary 40,000').text, 'The advert says £40,000.');
    assert.equal(withoutGuessedPay(answer('Budget of £5,000 managed.'), 'review my cv', 'x').text, 'Budget of £5,000 managed.', 'only when pay was asked');
});

test('a removed sentence does not leave "However" opening the answer', () => {
    const out = withoutUnverifiedFigures({ text: 'The going rate is £99,123 a year. However, it is not open to new applicants.', pieces: [], suggestions: [] }, 'x', true);
    assert.match(out.text, /^It is not open to new applicants\./);
});

test('a job type counts only if this message asks for one; a failed company lookup is never "no jobs"', async () => {
    const deps = fakeDeps();
    const [search] = createJobTools(deps);
    await search!.run({ role: 'data analyst', jobTypes: ['full-time', 'part-time', 'contract'] }, toolCtx({ userMessage: 'find me data analyst jobs' }).ctx);
    assert.deepEqual(deps.requests[0]!.filters, {});
    await search!.run({ role: 'retail', jobTypes: ['part-time'] }, toolCtx({ userMessage: 'part time retail jobs' }).ctx);
    assert.deepEqual(deps.requests[1]!.filters, { job_types: ['Part-time'] });
    const [broken] = createJobTools(fakeDeps({ companyIds: async () => { throw new Error('down'); } }));
    assert.equal(((await broken!.run({ company: 'Amazon' }, toolCtx({ userMessage: 'jobs at amazon' }).ctx)) as { error: string }).error, 'SEARCH_SLOW');
});

test('a whole cover letter fits in an example piece', () => {
    assert.equal(uiPieceSchema.safeParse({ type: 'example', title: 'Letter', text: 'Dear team. '.repeat(300) }).success, true);
    assert.equal(uiPieceSchema.safeParse({ type: 'facts', items: [{ label: 'Salary', value: 'Competitive salary with stock options and a long note about bonus and benefits here too' }] }).success, true);
});

test('a gap the CV plainly covers is dropped; a real one stays', () => {
    const cv = 'Full stack developer. Built APIs with PostgreSQL and React. TypeScript.';
    assert.deepEqual(realGaps(['SQL', 'experience with TypeScript', 'full-stack development', 'PHP', 'GraphQL', '3+ years of experience', 'strong skills'], cv), ['PHP', 'GraphQL', '3+ years of experience']);
});

test('the number asked for is the number shown; the list is kept for follow-ups', async () => {
    const [search] = createJobTools(fakeDeps({ ids: [1, 2, 3], explain: async () => [{ id: 1, have: [], missing: ['Rust'] }, { id: 2, have: [{ skill: 'SQL', quote: 'Built SQL pipelines' }, { skill: 'BI', quote: 'Power BI dashboards' }], missing: [] }, { id: 3, have: [{ skill: 'SQL', quote: 'Built SQL pipelines' }], missing: ['Rust'] }] }));
    const one = toolCtx();
    const out = (await search!.run({ count: 1 }, one.ctx)) as { count: number; jobs: Array<{ title: string; verdict: { label: string } }> };
    assert.equal(out.count, 1);
    assert.equal(out.jobs[0]!.title, 'Data Analyst 2', 'the best by verdict, not the first ranked');
    assert.equal(out.jobs[0]!.verdict.label, 'close');
    const cards = one.blocks.filter((b): b is Extract<AgentBlock, { kind: 'jobList' }> => b.kind === 'jobList');
    assert.equal(cards.find((c) => c.card.hidden)!.card.items.length, 3, 'kept for job 2 and more');
    assert.equal(cards.find((c) => c.card.pick)!.card.items.length, 1);
    const two = toolCtx();
    await search!.run({ count: 2 }, two.ctx);
    assert.equal((two.blocks.find((b) => b.kind === 'jobList' && b.card.pick) as Extract<AgentBlock, { kind: 'jobList' }>).card.items.length, 2);
    const all = toolCtx();
    await search!.run({ count: 3 }, all.ctx);
    assert.equal(all.blocks.length, 1, 'asking for as many as there are is just the list');
});

test('recommend_jobs picks from the list on screen without searching, and handles dead ends', async () => {
    const deps = fakeDeps({ explain: async () => [{ id: 7, have: [{ skill: 'SQL', quote: 'Built SQL pipelines' }, { skill: 'BI', quote: 'Power BI dashboards' }], missing: [] }] });
    const [, , , recommend] = createJobTools(deps);
    const list = { query: 'q', search: {}, shownIds: [], items: [{ id: 6, title: 'A', sponsor: false, have: [], missing: [] }, { id: 7, title: 'B', sponsor: false, have: [], missing: [] }] };
    const one = toolCtx({ lastJobs: list });
    const out = (await recommend!.run({ count: 1 }, one.ctx)) as { jobs: Array<{ title: string }> };
    assert.equal(out.jobs[0]!.title, 'B');
    assert.equal(deps.requests.length, 0, 'no new search');
    assert.equal((one.blocks[0] as Extract<AgentBlock, { kind: 'jobList' }>).card.pick, true);
    assert.equal(((await recommend!.run({ count: 1 }, toolCtx().ctx)) as { error: string }).error, 'NO_LIST');
    assert.equal(((await recommend!.run({ count: 1 }, toolCtx({ cv: null, lastJobs: list }).ctx)) as { error: string }).error, 'NEED_CV');
    const older = toolCtx({ lastJobs: list, jobLists: [list, { ...list, items: [{ id: 9, title: 'Old', sponsor: false, have: [], missing: [] }] }] });
    const [, details] = createJobTools(fakeDeps());
    assert.equal(((await details!.run({ position: 1, list: 1 }, older.ctx)) as { title: string }).title, 'Data Analyst 9', 'an earlier list can be read');
});

test('best first: verdict, then proof, then the ranking', () => {
    const job = (id: number, label: 'close' | 'possible' | 'stretch', have = 0, missing = 0) => ({ id, verdict: { label, reason: '' }, have: Array(have).fill(0), missing: Array(missing).fill(0) });
    assert.deepEqual(bestFirst([job(1, 'stretch', 5), job(2, 'possible', 1, 1), job(3, 'close', 2), job(4, 'close', 3)]).map((j) => j.id), [4, 3, 2, 1]);
    assert.deepEqual(bestFirst([job(1, 'close', 2), job(2, 'close', 2)]).map((j) => j.id), [1, 2]);
});

test('official-data hints still run first; job understanding is left to the AI', async () => {
    const can = new Set(['find_sponsors', 'soc_lookup', 'search_jobs', 'job_fit', 'get_cv_profile', 'gov_uk_guidance']);
    assert.deepEqual(forcedToolCalls('Which companies in Leeds sponsor visas?', can).filter((c) => c.name === 'find_sponsors'), [{ name: 'find_sponsors', args: { city: 'Leeds' } }]);
    assert.deepEqual(forcedToolCalls('What is the new entrant threshold for a nurse?', can).find((c) => c.name === 'soc_lookup')?.args, { query: 'nurse' });
    assert.deepEqual(forcedToolCalls('give me 2 jobs', can, { hasCv: true }), [], 'no word rule and no CV profile');
    assert.deepEqual(forcedToolCalls('compare me with job 1', can, { hasCv: true }), []);
    for (const m of ['is 8 pounds an hour legal', 'my employer isnt paying me', 'i was fired for being pregnant', 'what is a new entrant']) assert.ok(forcedToolCalls(m, can).some((c) => c.name === 'gov_uk_guidance'), m);
    assert.equal(withoutBracketedCodes('Transport managers (2134) and developers (1243), not (9999).', [{ kind: 'socCards', card: { options: [{ code: '2134' }, { code: '1243' }] } } as never]), 'Transport managers and developers, not (9999).');
    assert.equal((await searchJobs({ role: 'jobs' }, { cv: null, years: null, signal }, fakeDeps())).status, 'need_cv_or_role', 'the word jobs names no role');
    const nursing = await run({ role: 'nursing' }, fakeDeps({ details: async (ids) => ids.map((id) => job(id, { title: 'Staff Nurse' })) }));
    assert.ok(nursing.status === 'ok' && !nursing.card.fewCloseMatches);
    const deps = fakeDeps();
    const [search] = createJobTools(deps);
    await search!.run({ role: 'data', refine: true }, toolCtx({ lastJobs: { search: { role: 'chef', location: 'London' }, shownIds: [], items: [] } }).ctx);
    assert.deepEqual(deps.requests[0]!.filters, {}, 'a new role does not keep the old city');
    const named = await run({ role: 'nursing jobs', location: 'Leeds' }, fakeDeps());
    assert.ok(named.status === 'ok' && named.card.query === 'nursing jobs in Leeds');
});

test('recent job lists are found newest first, and a recommendation is not a list', () => {
    const conversation = newConversation('hello');
    assert.deepEqual(recentJobLists(conversation), []);
    const first = { query: 'first' } as JobListCard;
    const second = { query: 'second' } as JobListCard;
    conversation.messages.push(
        { role: 'assistant', text: 'a', blocks: [{ kind: 'jobList', card: first }], at: 1 },
        { role: 'assistant', text: 'b', blocks: [{ kind: 'jobList', card: second }], at: 2 },
        { role: 'assistant', text: 'c', blocks: [{ kind: 'jobList', card: { query: 'pick', pick: true } as JobListCard }], at: 3 },
    );
    assert.deepEqual(recentJobLists(conversation).map((l) => l.query), ['second', 'first']);
});
