import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { executeAiGeneration } from '../ai/orchestrator';
import { checkTailoredCv, parseQuestions, tailorBuild, tailorQuestions } from './tailor';
import { createCvTailorHandlers } from './tailorHandler';

const CV = `Priya Shah
priya.shah@example.com | +44 7700 900123 | linkedin.com/in/priyashah

PROFILE
Operations analyst with experience in Lean and process improvement.

EXPERIENCE
Operations Analyst, Acme Logistics Ltd, Leeds (2021 - Present)
- Ran weekly Kaizen workshops for 12 warehouse staff.
- Built Excel dashboards that cut reporting time by 30%.

Graduate Trainee, Northwind Retail, Manchester (2019 - 2021)
- Supported store audits and stock counts.

EDUCATION
BSc Business Management, University of Leeds, 2016 - 2019

SKILLS
Excel, SQL, Lean, Kaizen, stakeholder management

CERTIFICATIONS
Lean Six Sigma Green Belt`;

const JD = `Continuous Improvement Analyst, Contoso Foods, Bradford.
We are looking for a Continuous Improvement Analyst to lead Lean projects across our sites.
Essential: Lean Six Sigma Green Belt, Excel, Power BI, root cause analysis, stakeholder management.
You will run Kaizen events and report savings to the leadership team.`;

/** A fake model: returns the given JSON text and records each request. */
function fakeGenerate(outputs: unknown[], seen: string[] = []): typeof executeAiGeneration {
    let i = 0;
    return (async (_op: unknown, request: { systemInstruction?: { parts: Array<{ text: string }> }; contents: Array<{ parts: Array<{ text: string }> }> }) => {
        seen.push(request.contents.map((c) => c.parts.map((p) => p.text).join('')).join('\n'));
        const output = outputs[Math.min(i++, outputs.length - 1)];
        return {
            ok: true,
            body: { candidates: [{ content: { parts: [{ text: typeof output === 'string' ? output : JSON.stringify(output) }] } }] },
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            attempts: 1,
            latencyMs: 5,
            diagnostics: { promptTokens: 100, outputTokens: 50 },
        };
    }) as unknown as typeof executeAiGeneration;
}

const QUESTIONS = {
    isCv: true,
    isJobDescription: true,
    job: { title: 'Continuous Improvement Analyst', company: 'Contoso Foods' },
    questions: [
        {
            id: 'q1',
            text: 'The role asks for Power BI. Have you used it?',
            why: 'Power BI is essential for this job.',
            skill: 'Power BI',
            options: [
                { label: 'Yes, at work', confirms: true },
                { label: 'Yes, in a course', confirms: true },
                { label: 'No', confirms: false },
            ],
        },
        { id: 'q2', text: 'Roughly how much did your Kaizen workshops save?', options: [{ label: 'Under £10k' }, { label: '£10k to £50k' }, { label: 'Not measured' }] },
    ],
};

test('questions: valid questions are kept, with their options and skill checks', () => {
    const parsed = parseQuestions(QUESTIONS);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.questions.length, 2);
    assert.equal(parsed.questions[0].skill, 'Power BI');
    assert.deepEqual(parsed.questions[0].options.map((o) => o.confirms), [true, true, false]);
    assert.equal(parsed.job.title, 'Continuous Improvement Analyst');
});

test('questions: broken items are dropped, duplicates removed, at most 6 kept, ids unique', () => {
    const many = Array.from({ length: 9 }, (_, n) => ({ id: 'q1', text: `Question number ${n}?`, options: [{ label: 'Yes' }, { label: 'No' }] }));
    const parsed = parseQuestions({
        ...QUESTIONS,
        questions: [
            { id: 'x', text: 'No options here?', options: [] },
            { id: 'y', text: '', options: [{ label: 'A' }, { label: 'B' }] },
            { id: 'z', text: 'Question number 0?', options: [{ label: 'Yes' }, { label: 'No' }] },
            ...many,
        ],
    });
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.questions.length, 6);
    assert.equal(new Set(parsed.questions.map((q) => q.id)).size, 6);
    assert.equal(parsed.questions.filter((q) => q.text === 'Question number 0?').length, 1);
});

test('questions: questions asking for personal or contact details are dropped', () => {
    const parsed = parseQuestions({
        ...QUESTIONS,
        questions: [
            { id: 'a', text: 'What is your date of birth?', options: [{ label: 'Prefer not to say' }, { label: 'Tell me' }] },
            { id: 'b', text: 'What is your email address?', options: [{ label: 'Type it' }, { label: 'Skip' }] },
            { id: 'c', text: 'Which of your roles is most relevant?', options: [{ label: 'Acme' }, { label: 'Northwind' }] },
        ],
    });
    assert.ok(parsed.ok);
    if (parsed.ok) assert.deepEqual(parsed.questions.map((q) => q.text), ['Which of your roles is most relevant?']);
});

test('questions: the model can say the CV or the job text is not what it should be', () => {
    assert.deepEqual(parseQuestions({ isCv: false, isJobDescription: true, questions: [] }), { ok: false, reason: 'not_cv' });
    assert.deepEqual(parseQuestions({ isCv: true, isJobDescription: false, questions: [] }), { ok: false, reason: 'not_job' });
    assert.deepEqual(parseQuestions('nonsense'), { ok: false, reason: 'bad_output' });
});

test('questions: contact details are removed before the CV is sent to the AI', async () => {
    const seen: string[] = [];
    const result = await tailorQuestions({ cvText: CV, jobDescription: JD }, { generate: fakeGenerate([QUESTIONS], seen), signal: new AbortController().signal });
    assert.ok(result.ok);
    assert.equal(seen.length, 1);
    assert.ok(!seen[0].includes('priya.shah@example.com'));
    assert.ok(!seen[0].includes('7700 900123'));
    assert.ok(seen[0].includes('Acme Logistics Ltd'));
    assert.equal(result.calls.length, 1);
});

test('questions: one retry when the first reply is unreadable', async () => {
    const result = await tailorQuestions({ cvText: CV, jobDescription: JD }, { generate: fakeGenerate(['{"broken', QUESTIONS]), signal: new AbortController().signal });
    assert.ok(result.ok);
    assert.equal(result.calls.length, 2);
});

const TAILORED = {
    cv: {
        headline: 'Continuous Improvement Analyst | Lean Six Sigma Green Belt',
        summary: 'Operations analyst who runs Lean and Kaizen improvement work. Cut reporting time by 30% with Excel dashboards. Saved £2m a year across five sites.',
        skills: [
            { group: 'Continuous improvement', items: ['Lean', 'Kaizen', 'Root cause analysis', 'Six Sigma', 'Python'] },
            { group: 'Data', items: ['Excel', 'SQL', 'Power BI', 'Tableau'] },
        ],
        experience: [
            {
                title: 'Operations Analyst',
                employer: 'Acme Logistics Ltd',
                location: 'Leeds',
                dates: '2021 - Present',
                bullets: [
                    'Led weekly Kaizen workshops for 12 warehouse staff.',
                    'Built Excel dashboards that cut reporting time by 30%.',
                    'Delivered savings of £250k through waste reduction.',
                ],
            },
            { title: 'Graduate Trainee', employer: 'Northwind Retail', dates: '2019 - 2021', bullets: ['Supported store audits and stock counts.'] },
            { title: 'Head of Operations', employer: 'Globex Corporation', dates: '2015 - 2018', bullets: ['Ran everything.'] },
        ],
        education: [
            { qualification: 'BSc Business Management', institution: 'University of Leeds', dates: '2016 - 2019' },
            { qualification: 'MBA', institution: 'Harvard Business School', dates: '2020' },
        ],
        projects: [],
        certifications: ['Lean Six Sigma Green Belt', 'PMP'],
        extras: [],
    },
    changes: ['Moved Kaizen work to the top.'],
};

const ANSWERS = [
    { questionId: 'q1', question: 'The role asks for Power BI. Have you used it?', answer: 'Yes, at work', skill: 'Power BI', confirmed: true },
    { questionId: 'q2', question: 'Roughly how much did your Kaizen workshops save?', answer: 'Not measured' },
];

test('truth check: invented roles, schools, certificates, skills and numbers are removed', () => {
    const { cv, removed } = checkTailoredCv(TAILORED.cv, { cvText: CV, answers: ANSWERS });
    assert.deepEqual(cv.experience.map((r) => r.employer), ['Acme Logistics Ltd', 'Northwind Retail']);
    assert.deepEqual(cv.education.map((e) => e.institution), ['University of Leeds']);
    assert.deepEqual(cv.certifications, ['Lean Six Sigma Green Belt']);
    const skills = cv.skills.flatMap((g) => g.items);
    assert.ok(skills.includes('Power BI'), 'confirmed by an answer');
    assert.ok(skills.includes('Lean') && skills.includes('Excel'));
    for (const invented of ['Tableau', 'Root cause analysis', 'Python']) assert.ok(!skills.includes(invented), invented);
    assert.deepEqual(cv.experience[0].bullets, ['Led weekly Kaizen workshops for 12 warehouse staff.', 'Built Excel dashboards that cut reporting time by 30%.']);
    assert.ok(cv.summary.includes('30%'));
    assert.ok(!cv.summary.includes('£2m'));
    assert.ok(removed >= 8);
});

test('truth check: a skill the user said they do not have is never added', () => {
    const answers = [{ ...ANSWERS[0], answer: 'No', confirmed: false }];
    const { cv } = checkTailoredCv(TAILORED.cv, { cvText: CV, answers });
    assert.ok(!cv.skills.flatMap((g) => g.items).includes('Power BI'));
});

test('truth check: a number the user typed in an answer may be used', () => {
    const answers = [{ questionId: 'q2', question: 'How much did the workshops save?', answer: 'About £250k a year' }];
    const { cv } = checkTailoredCv(TAILORED.cv, { cvText: CV, answers });
    assert.ok(cv.experience[0].bullets.some((b) => b.includes('£250k')));
});

test('truth check: years of experience may be stated when the CV dates support them', () => {
    const summary = 'Operations analyst with 7 years of experience in Lean. Has 25 years of leadership.';
    const { cv } = checkTailoredCv({ ...TAILORED.cv, summary }, { cvText: CV, answers: [] });
    assert.equal(cv.summary, 'Operations analyst with 7 years of experience in Lean.');
});

test('truth check: a role whose title was lightly reworded but employer is real is kept', () => {
    const roles = [{ title: 'Ops Analyst', employer: 'Acme Logistics', dates: '2021 - Present', bullets: ['Ran Kaizen workshops.'] }];
    const { cv } = checkTailoredCv({ ...TAILORED.cv, experience: roles }, { cvText: CV, answers: [] });
    assert.equal(cv.experience.length, 1);
});

test('truth check: a role with dates the CV does not have is removed', () => {
    const roles = [{ title: 'Operations Analyst', employer: 'Acme Logistics Ltd', dates: '2012 - 2014', bullets: ['Ran Kaizen workshops.'] }];
    const { cv } = checkTailoredCv({ ...TAILORED.cv, experience: roles }, { cvText: CV, answers: [] });
    assert.equal(cv.experience.length, 0);
});

test('build: returns the checked CV and the notes on what changed', async () => {
    const seen: string[] = [];
    const result = await tailorBuild(
        { cvText: CV, jobDescription: JD, answers: ANSWERS },
        { generate: fakeGenerate([TAILORED], seen), signal: new AbortController().signal },
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.cv.experience.length, 2);
    assert.deepEqual(result.changes, ['Moved Kaizen work to the top.']);
    assert.ok(!seen[0].includes('priya.shah@example.com'));
    assert.ok(seen[0].includes('Yes, at work'));
});

test('build: fails when nothing usable is left', async () => {
    const empty = { cv: { ...TAILORED.cv, experience: [TAILORED.cv.experience[2]], education: [TAILORED.cv.education[1]] }, changes: [] };
    const result = await tailorBuild({ cvText: CV, jobDescription: JD, answers: [] }, { generate: fakeGenerate([empty]), signal: new AbortController().signal });
    assert.equal(result.ok, false);
});

// ---- HTTP handlers ----

function fakeRes() {
    const res = {
        statusCode: 200,
        body: undefined as unknown,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) {
            res.headers[name] = value;
        },
        status(code: number) {
            res.statusCode = code;
            return res;
        },
        json(body: unknown) {
            res.body = body;
            return res;
        },
    };
    return res;
}

const req = (body: unknown, uid: string | null = 'u1') => ({ body, user: uid ? { uid } : undefined }) as unknown as Request;
const cvBody = { name: 'My CV', text: CV };

function handlers(extra: Partial<Parameters<typeof createCvTailorHandlers>[0]> = {}) {
    const consumed: string[] = [];
    const h = createCvTailorHandlers({
        generate: fakeGenerate([QUESTIONS]),
        hasAccess: async () => true,
        consume: async (_uid, kind) => {
            consumed.push(kind);
            return { allowed: true, used: 1, limit: 100 };
        },
        usageStore: null,
        ...extra,
    });
    return { h, consumed };
}

test('handler: needs sign-in, a valid body and the plan', async () => {
    const { h } = handlers();
    let res = fakeRes();
    await h.questions(req({ cv: cvBody, jobDescription: JD }, null), res as unknown as Response);
    assert.equal(res.statusCode, 401);
    res = fakeRes();
    await h.questions(req({ cv: cvBody, jobDescription: 'short' }), res as unknown as Response);
    assert.equal(res.statusCode, 400);
    const noPlan = handlers({ hasAccess: async () => false });
    res = fakeRes();
    await noPlan.h.questions(req({ cv: cvBody, jobDescription: JD }), res as unknown as Response);
    assert.equal(res.statusCode, 403);
    assert.equal((res.body as { error: string }).error, 'PLAN_REQUIRED');
});

test('handler: the daily limit applies', async () => {
    const { h } = handlers({ consume: async () => ({ allowed: false, used: 151, limit: 150 }) });
    const res = fakeRes();
    await h.questions(req({ cv: cvBody, jobDescription: JD }), res as unknown as Response);
    assert.equal(res.statusCode, 429);
    assert.equal((res.body as { error: string }).error, 'LIMIT_REACHED');
});

test('handler: questions are returned and counted; nothing about the CV is stored', async () => {
    const { h, consumed } = handlers();
    const res = fakeRes();
    await h.questions(req({ cv: cvBody, jobDescription: JD }), res as unknown as Response);
    assert.equal(res.statusCode, 200);
    const body = res.body as { questions: unknown[]; job: { title: string } };
    assert.equal(body.questions.length, 2);
    assert.equal(body.job.title, 'Continuous Improvement Analyst');
    assert.deepEqual(consumed, ['turns', 'aiCalls']);
    assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('handler: a job description that is not one gets a clear message', async () => {
    const { h } = handlers({ generate: fakeGenerate([{ isCv: true, isJobDescription: false, questions: [] }]) });
    const res = fakeRes();
    await h.questions(req({ cv: cvBody, jobDescription: JD }), res as unknown as Response);
    assert.equal(res.statusCode, 422);
    assert.equal((res.body as { error: string }).error, 'NOT_JOB_DESCRIPTION');
});

test('handler: build returns the tailored CV', async () => {
    const { h } = handlers({ generate: fakeGenerate([TAILORED]) });
    const res = fakeRes();
    await h.build(req({ cv: cvBody, jobDescription: JD, answers: ANSWERS }), res as unknown as Response);
    assert.equal(res.statusCode, 200);
    const body = res.body as { cv: { experience: unknown[] }; changes: string[] };
    assert.equal(body.cv.experience.length, 2);
});

test('handler: an AI failure is reported as retryable, never as a crash', async () => {
    const failing = (async () => ({ ok: false, status: 503, errorText: 'down' })) as unknown as typeof executeAiGeneration;
    const { h } = handlers({ generate: failing });
    const res = fakeRes();
    await h.build(req({ cv: cvBody, jobDescription: JD, answers: [] }), res as unknown as Response);
    assert.equal(res.statusCode, 502);
    assert.equal((res.body as { error: string }).error, 'AI_UNAVAILABLE');
});
