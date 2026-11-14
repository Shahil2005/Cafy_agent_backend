import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { executeAiGeneration } from '../ai/orchestrator';
import { cleanAnswer } from './agent';
import type { AgentEvent } from './contract';
import { appendMessages, newConversation } from './conversations';
import { chunkCv, CHUNK_CHARS, DENSE_CHUNK_CHARS, collapseSymbolRuns, splitSections } from './cv/chunk';
import { fitJobPieces, jobContentHash, jobPieces, jobText } from './jobs/pieces';
import { indexCv, searchCv, type CvIndex } from './cv';
import { extractCvProfile, normaliseCvText, quoteInText } from './cv/profile';
import { experienceYears } from './cv/years';
import { careerText } from '../jobs-portal/careerMatchProfile';
import { createAgentTurnHandler, createConversationHandlers } from './handler';
import { needsSummary, recentHistory, refreshSummary } from './memory';
import { CV_TOOLS } from './tools/cv';
import { memoryStores } from './testStores';

type Generate = typeof executeAiGeneration;

/** Fictional CV only: no real person's data in tests. */
const CV = `Alex Example
alex.example@mail.test | +44 7700 900123 | London

PROFESSIONAL SUMMARY
Computer Science graduate who enjoys turning data into decisions.

EXPERIENCE
Data Analyst Intern, Northwind Retail, Jun 2023 - Aug 2023
Built weekly sales dashboards in Power BI and automated reporting with Python.
Junior Analyst, Contoso Health, 2024-01 - present
Wrote SQL queries to track patient waiting times across 12 clinics.

EDUCATION
BSc Computer Science, University of Exampletown, 2020 - 2023, First Class

PROJECTS
Football Stats App: a React and Node.js app showing league tables.

SKILLS
Python, SQL, Power BI, React, Excel`;

function fakeModel(outputs: string[]): Generate {
    return async () => {
        const text = outputs.shift();
        if (text === undefined) return { ok: false, status: 500, errorText: 'none' };
        return {
            ok: true,
            body: { candidates: [{ content: { parts: [{ text }] } }] },
            diagnostics: { promptTokens: 800, outputTokens: 300, contentParts: 1, textParts: 1, thoughtParts: 0, functionCallParts: 0 },
            provider: 'gemini',
            model: 'gemini-2.5-flash-lite',
            attempts: 1,
            latencyMs: 3,
        };
    };
}

/** Deterministic fake embedding: bag of letters, normalised. */
const fakeEmbed = async (texts: string[]) =>
    texts.map((t) => {
        const v = new Array(26).fill(0);
        for (const ch of t.toLowerCase()) if (ch >= 'a' && ch <= 'z') v[ch.charCodeAt(0) - 97] += 1;
        const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    });

const PROFILE_JSON = JSON.stringify({
    headline: 'Computer Science graduate with data analysis experience',
    roles: [
        { title: 'Data Analyst Intern', employer: 'Northwind Retail', start: '2023-06', end: '2023-08', evidence: 'Data Analyst Intern, Northwind Retail, Jun 2023' },
        { title: 'Junior Analyst', employer: 'Contoso Health', start: '2024-01', end: 'present', evidence: 'Wrote SQL queries to track patient waiting times' },
        { title: 'Head of AI', employer: 'Made Up Ltd', start: '2019', evidence: 'Led a team of 50 AI researchers' },
    ],
    education: [{ qualification: 'BSc Computer Science', institution: 'University of Exampletown', start: '2020', end: '2023', evidence: 'BSc Computer Science, University of Exampletown' }],
    skills: [
        { name: 'Python', source: 'experience', evidence: 'automated reporting with Python' },
        { name: 'React', source: 'project', evidence: 'a React and Node.js app' },
        { name: 'Kubernetes', source: 'experience', evidence: 'deployed Kubernetes clusters' },
    ],
    projects: [{ name: 'Football Stats App', technologies: ['React', 'Node.js'], evidence: 'Football Stats App: a React and Node.js app' }],
    hasPersonalStatement: true,
});

test('divider lines are shortened and real words kept', () => {
    assert.equal(collapseSymbolRuns('Role\n__________\nA-B -- C'), 'Role\n___\nA-B -- C');
});

test('dense text gets small pieces; normal adverts keep their cuts and hash', () => {
    const dense = 'Quản lý chất lượng tại công đoạn lắp ráp cuối cùng. '.repeat(120);
    const cv = chunkCv(`Experience\n${dense}`);
    assert.ok(cv.length > 1 && cv.every((c) => c.text.length <= DENSE_CHUNK_CHARS + 40));
    const pieces = jobPieces({ title: 'QA', description: dense });
    assert.ok(pieces.length > 1 && pieces.every((p) => p.text.length <= DENSE_CHUNK_CHARS));
    const normal = { title: 'Nurse', description: 'Care for patients on the ward. '.repeat(200) };
    assert.ok(jobPieces(normal).some((p) => p.text.length > DENSE_CHUNK_CHARS));
    assert.equal(jobContentHash({ title: 'Nurse', description: 'Care for patients.' }), '3da1e1e091b8eef84f0abba24014a9f1');
});

test('an advert the tokenizer finds too long is cut small, covers all its text and keeps its hash', () => {
    const job = { title: 'Gweithiwr', description: 'Trwydded yrru lawn y DU a mynediad at gerbyd. '.repeat(100) };
    const normal = jobPieces(job);
    assert.deepEqual(fitJobPieces(job, () => 100), normal, 'a job that fits keeps its normal cuts');
    const small = fitJobPieces(job, (text) => text.length);
    assert.ok(small.length > normal.length && small.every((p) => p.text.length <= DENSE_CHUNK_CHARS));
    const text = jobText(job);
    let coveredTo = 0;
    for (const p of small) {
        assert.ok(p.start <= coveredTo, 'no gap between pieces');
        coveredTo = p.end;
    }
    assert.equal(coveredTo, text.length);
    assert.equal(jobContentHash(job), jobContentHash({ ...job }));
});

test('chunking keeps every line, respects sections and the size limit', () => {
    const long = `EXPERIENCE\n${Array.from({ length: 300 }, (_, i) => `Line ${i}: delivered measurable results for project number ${i}.`).join('\n')}\nSKILLS\nPython, SQL`;
    const chunks = chunkCv(long);
    assert.ok(chunks.length > 5, 'long sections are split');
    assert.ok(chunks.every((c) => c.text.length <= CHUNK_CHARS));
    for (let i = 0; i < 300; i++) assert.ok(chunks.some((c) => c.text.includes(`Line ${i}:`)), `line ${i} kept`);
    assert.ok(chunks.some((c) => c.section === 'Skills' && c.text.includes('Python, SQL')));
    assert.deepEqual(splitSections(CV).map((s) => s.section), ['Top of CV', 'Professional summary', 'Experience', 'Education', 'Projects', 'Skills']);
});

test('experience years merge overlaps and handle present, months and bare years', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    const result = experienceYears(
        [
            { title: 'A', start: '2023-06', end: '2023-08' },
            { title: 'B', start: '2024-01', end: 'present' },
            { title: 'C', start: '2024-06', end: '2024-12' },
            { title: 'D' },
        ],
        now,
    );
    // Jun–Aug 2023 = 3 months; Jan 2024–Oct 2026 = 34 months; C overlaps B.
    assert.equal(result.totalMonths, 37);
    assert.equal(result.years, 3.1);
    assert.deepEqual(result.undatedRoles, ['D']);
});

test('profile extraction drops items whose evidence is not in the CV', async () => {
    const { profile } = await extractCvProfile(CV, { signal: new AbortController().signal, generate: fakeModel([PROFILE_JSON]) });
    assert.deepEqual(profile.roles.map((r) => r.title), ['Data Analyst Intern', 'Junior Analyst']);
    assert.deepEqual(profile.skills.map((s) => s.name), ['Python', 'React']);
    assert.equal(profile.projects.length, 1);
});

test('indexing removes contact details, stores once and reuses the saved analysis', async () => {
    const stores = memoryStores();
    let extracts = 0;
    const extract: typeof extractCvProfile = async (text, opts) => {
        extracts++;
        assert.ok(!text.includes('alex.example@mail.test'), 'email removed before AI');
        assert.ok(!text.includes('7700 900123'), 'phone removed before AI');
        return extractCvProfile(text, { ...opts, generate: fakeModel([PROFILE_JSON]) });
    };
    const opts = { signal: new AbortController().signal, store: stores.cvStore, embed: fakeEmbed, extract };
    const first = await indexCv('u1', { name: 'CV.pdf', text: CV }, opts);
    assert.equal(first.cached, false);
    assert.ok(first.index.chunks.length >= 5);
    assert.ok(first.index.chunks.every((c) => c.embedding.length === 26));
    const second = await indexCv('u1', { name: 'CV renamed.pdf', text: CV }, opts);
    assert.equal(second.cached, true);
    assert.equal(second.index.name, 'CV renamed.pdf');
    assert.equal(extracts, 1, 'AI runs once per CV version');
});

async function sampleIndex(): Promise<CvIndex> {
    const stores = memoryStores();
    return (
        await indexCv('u1', { name: 'CV.pdf', text: CV }, {
            signal: new AbortController().signal,
            store: stores.cvStore,
            embed: fakeEmbed,
            extract: (t, o) => extractCvProfile(t, { ...o, generate: fakeModel([PROFILE_JSON]) }),
        })
    ).index;
}

test('search covers the whole CV and ranks the most relevant piece first', async () => {
    const index = await sampleIndex();
    const hits = await searchCv(index, 'BSc Computer Science University of Exampletown First Class', { embed: fakeEmbed });
    assert.equal(hits[0]!.section, 'Education');
});

test('quotes survive only when the words are really in the CV', async () => {
    const index = await sampleIndex();
    const haystack = normaliseCvText(index.text);
    const answer = cleanAnswer(
        {
            text: 'You have SQL experience.',
            ui: [
                { type: 'quote', text: 'Wrote SQL queries to track patient waiting times', section: 'Experience' },
                { type: 'quote', text: 'Managed a £2m budget', section: 'Experience' },
            ],
            suggestions: [],
        },
        (t) => quoteInText(t, haystack),
    );
    assert.equal(answer.pieces.length, 1);
    assert.equal(cleanAnswer({ text: 't', ui: [{ type: 'quote', text: 'anything here' }], suggestions: [] }).pieces.length, 0, 'no CV, no quotes');
});

test('CV tools ask for a CV when none is selected, and answer from it when one is', async () => {
    const emitted: string[] = [];
    const ctx = { uid: 'u1', signal: new AbortController().signal, cv: null, emit: (_id: string, b: { kind: string }) => emitted.push(b.kind) };
    const profileTool = CV_TOOLS.find((t) => t.name === 'get_cv_profile')!;
    const missing = (await profileTool.run({}, ctx)) as { error?: string };
    assert.equal(missing.error, 'NO_CV_SELECTED');
    assert.deepEqual(emitted, ['cvPicker']);
    const index = await sampleIndex();
    const years = CV_TOOLS.find((t) => t.name === 'get_experience_years')!;
    const result = (await years.run({}, { ...ctx, cv: index })) as { years: number };
    assert.ok(result.years > 2);
});

async function post(app: express.Express, path: string, body: unknown, method = 'POST') {
    const server = app.listen(0);
    try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, text: await res.text() };
    } finally {
        server.close();
    }
}

function events(text: string): AgentEvent[] {
    return text.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
}

test('choosing a CV shows live steps and the CV card, then saves the conversation', async () => {
    const stores = memoryStores();
    const answer = JSON.stringify({ answer: { text: 'I have read your whole CV.', ui: [], suggestions: ['What are my strongest skills?'] } });
    const handler = createAgentTurnHandler({
        hasAccess: async () => true,
        consume: async () => ({ allowed: true, used: 1, limit: 100 }),
        conversations: stores.conversations,
        cvStore: stores.cvStore,
        embed: fakeEmbed,
        extractCv: (t, o) => extractCvProfile(t, { ...o, generate: fakeModel([PROFILE_JSON]) }),
        generate: fakeModel([answer]),
        tools: [],
    });
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/turn', (req, _res, next) => { (req as any).user = { uid: 'u1' }; next(); }, handler);
    const res = await post(app, '/turn', { message: 'Use my CV “CV.pdf”', cv: { name: 'CV.pdf', text: CV } });
    const list = events(res.text);
    const labels = list.filter((e) => e.type === 'status').map((e) => (e as { label: string }).label);
    assert.ok(labels.includes('Reading every page of your CV'));
    assert.ok(labels.includes('Indexing your CV so I can search all of it'));
    assert.ok(list.some((e) => e.type === 'block' && e.block.kind === 'cvProfile'));
    assert.ok(list.some((e) => e.type === 'done'));
    const id = (list.find((e) => e.type === 'conversation') as { id: string }).id;
    const saved = stores.convs.get(id);
    assert.equal(saved.cvName, 'CV.pdf');
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].blocks[0].kind, 'cvProfile', 'blocks saved so a reopened chat shows them');
});

test('follow-up turns reuse the stored conversation and CV without re-reading it', async () => {
    const stores = memoryStores();
    const index = await sampleIndex();
    stores.cvs.set(index.hash, index);
    const conv = appendMessages({ ...newConversation('first'), cvHash: index.hash, cvName: 'CV.pdf' }, [
        { role: 'user', text: 'How do I explain a gap year?', at: 1 },
        { role: 'assistant', text: 'Name it and show what you learned.', at: 1 },
    ]);
    stores.convs.set(conv.id, conv);
    const prompts: string[] = [];
    const generate: Generate = async (op, request) => {
        prompts.push((request.contents as Array<{ parts: Array<{ text: string }> }>)[0].parts[0].text);
        return fakeModel([JSON.stringify({ answer: { text: 'Here is a shorter version.', suggestions: [] } })])(op, request);
    };
    const app = express();
    app.use(express.json());
    app.post('/turn', (req, _res, next) => { (req as any).user = { uid: 'u1' }; next(); }, createAgentTurnHandler({
        hasAccess: async () => true,
        consume: async () => ({ allowed: true, used: 1, limit: 100 }),
        conversations: stores.conversations,
        cvStore: stores.cvStore,
        generate,
        tools: [],
    }));
    const res = await post(app, '/turn', { conversationId: conv.id, message: 'make it shorter' });
    assert.ok(!events(res.text).some((e) => e.type === 'conversation'), 'existing conversation, no new id');
    assert.match(prompts[0]!, /How do I explain a gap year/);
    assert.match(prompts[0]!, /"selectedCv"/);
    assert.equal(stores.convs.get(conv.id).messages.length, 4);
});

test('long conversations fold older messages into a short summary', async () => {
    let conv = newConversation('start');
    for (let i = 0; i < 20; i++) conv = appendMessages(conv, [{ role: i % 2 ? 'assistant' : 'user', text: `message ${i}`, at: i }]);
    assert.equal(needsSummary(conv), true);
    const { conversation, call } = await refreshSummary(conv, {
        signal: new AbortController().signal,
        generate: fakeModel([JSON.stringify({ summary: 'User wants data analyst roles in Leeds.' })]),
    });
    assert.ok(call);
    assert.equal(conversation.summary, 'User wants data analyst roles in Leeds.');
    assert.equal(conversation.summarizedCount, 12);
    assert.equal(needsSummary(conversation), false);
    assert.equal(recentHistory(conversation).length, 8);
});

test('conversation routes list, open and delete only valid ids', async () => {
    const stores = memoryStores();
    const conv = appendMessages(newConversation('Gap year help'), [{ role: 'user', text: 'hi', at: 1 }]);
    stores.convs.set(conv.id, conv);
    const handlers = createConversationHandlers(stores.conversations);
    const app = express();
    app.use((req, _res, next) => { (req as any).user = { uid: 'u1' }; next(); });
    app.get('/c', handlers.list);
    app.get('/c/:id', handlers.get);
    app.delete('/c/:id', handlers.remove);
    assert.match((await post(app, '/c', null, 'GET')).text, /Gap year help/);
    assert.equal((await post(app, `/c/${conv.id}`, null, 'GET')).status, 200);
    assert.equal((await post(app, '/c/bad..id', null, 'GET')).status, 400);
    assert.equal((await post(app, '/c/aaaaaaaaaaaaaaaaaaaaaaaa', null, 'GET')).status, 404);
    assert.equal((await post(app, `/c/${conv.id}`, null, 'DELETE')).status, 204);
    assert.equal(stores.convs.has(conv.id), false);
});

test('volunteering is reported separately from professional years', async () => {
    const { cvExperience } = await import('./cv');
    const index = await sampleIndex();
    index.profile.roles.push({ title: 'Code Club mentor', type: 'volunteering', start: '2020', end: '2023', evidence: 'x' });
    const exp = cvExperience(index, new Date('2026-10-30T00:00:00Z'));
    assert.equal(exp.years, 3.1);
    assert.equal(exp.volunteeringYears, 4);
});

test('a failed save does not block the answer, and failures report their step without CV text', async () => {
    const { CvIndexError, describeCvError } = await import('./cv');
    const failingStore = { get: async () => null, put: async () => { throw Object.assign(new Error('Cannot use "undefined" as a Firestore value'), { code: 'invalid-argument' }); } };
    const result = await indexCv('u1', { name: 'CV.pdf', text: CV }, {
        signal: new AbortController().signal,
        store: failingStore,
        embed: fakeEmbed,
        extract: (t, o) => extractCvProfile(t, { ...o, generate: fakeModel([PROFILE_JSON]) }),
    });
    assert.ok(result.index.chunks.length > 0, 'CV still usable this turn');
    await assert.rejects(
        indexCv('u1', { name: 'CV.pdf', text: CV }, { signal: new AbortController().signal, store: memoryStores().cvStore, embed: fakeEmbed, extract: async () => { throw new Error('Alex Example secret CV text'); } }),
        (error: unknown) => {
            const info = describeCvError(error);
            assert.equal(info.stage, 'understand');
            assert.ok(!JSON.stringify(info).includes('Alex'), 'no CV text in diagnostics');
            return error instanceof CvIndexError;
        },
    );
});

test('vectors survive packing for storage', async () => {
    const { packVector, unpackVector } = await import('./cv');
    const v = Array.from({ length: 384 }, (_, i) => Math.sin(i) / 10);
    const back = unpackVector(packVector(v));
    assert.equal(back.length, 384);
    assert.ok(back.every((x, i) => Math.abs(x - v[i]!) < 1e-6));
    assert.ok(packVector(v).length < 2100);
});

describeLongCvTests();

function describeLongCvTests() {
    const skills = Array.from({ length: 150 }, (_, i) => `Skill${i}`);
    const roles = Array.from({ length: 30 }, (_, i) => ({ title: `Engineer ${i}`, employer: `Company ${i}`, start: `20${String(i % 20).padStart(2, '0')}`, line: `Engineer ${i} at Company ${i} building payment platforms and leading delivery for client number ${i}` }));
    const longBullet = 'Designed and delivered an end-to-end data platform migration ' + 'across many regional teams while keeping every service running smoothly '.repeat(8);
    const detail = ' - responsible for requirements, design reviews, automated testing, cloud deployment, monitoring and on-call support, working closely with product owners and stakeholders across the business to deliver measurable outcomes';
    const bigCv = ['WORK EXPERIENCE', ...roles.map((r) => r.line + detail), longBullet, 'SKILLS', skills.join(', ')].join('\n');
    const bigProfile = {
        headline: 'Senior engineer with long platform experience',
        roles: roles.map((r) => ({ title: r.title, employer: r.employer, start: r.start, evidence: r.line })),
        skills: skills.map((s) => ({ name: s, source: 'skills-list', evidence: skills.slice(Math.max(0, skills.indexOf(s) - 2), skills.indexOf(s) + 3).join(', ') })),
        achievements: [{ text: 'Led a large migration', evidence: longBullet }],
    };

    test('a long CV keeps every role, every skill and long evidence (no caps)', async () => {
        const { profile } = await extractCvProfile(bigCv, { signal: new AbortController().signal, generate: fakeModel([JSON.stringify(bigProfile)]) });
        assert.equal(profile.roles.length, 30);
        assert.equal(profile.skills.length, 150);
        assert.equal(profile.achievements.length, 1);
        assert.ok(profile.achievements[0]!.evidence.length > 500);
    });

    test('one malformed item is skipped; the rest are kept; invented items are dropped', async () => {
        const json = JSON.stringify({
            headline: 'Data analyst',
            roles: [
                { title: 'Data Analyst Intern', employer: 'Northwind Retail', evidence: 'Data Analyst Intern, Northwind Retail, Jun 2023' },
                { employer: 'No title here', evidence: 'Data Analyst Intern, Northwind Retail' },
                { title: 'CEO', employer: 'Invented Ltd', evidence: 'Founded a unicorn company in 2019' },
            ],
            skills: [{ name: 'Python', source: 'experience', evidence: 'automated reporting with Python' }],
        });
        const { profile } = await extractCvProfile(CV, { signal: new AbortController().signal, generate: fakeModel([json]) });
        assert.deepEqual(profile.roles.map((r) => r.title), ['Data Analyst Intern']);
        assert.equal(profile.skills.length, 1);
    });

    test('quotes with different line breaks or bullets than the CV are still recognised', async () => {
        const { CvTextMatcher } = await import('./cv/profile');
        const matcher = new CvTextMatcher('• Built weekly sales dash-\nboards in Power BI and automated\nreporting with Python.');
        assert.equal(matcher.contains('Built weekly sales dashboards in Power BI and automated reporting with Python'), true);
        assert.equal(matcher.contains('Managed a team of forty engineers across three countries'), false);
    });

    test('a cut-off read is re-read in parts and merged without losing or duplicating items', async () => {
        const { splitWindows } = await import('./cv/profile');
        const cut = '{"headline":"Senior engineer","roles":[{"title":"Engineer 0"';
        const parts = splitWindows(bigCv, 6000, 1500);
        assert.ok(bigCv.length > 6000 && bigCv.length <= 15000, `CV size ${bigCv.length}`);
        assert.ok(parts.length >= 2, 'CV is long enough to split');
        // Each part returns the full profile; merging must still give exactly one of each item.
        const outputs = [cut, ...parts.map(() => JSON.stringify(bigProfile))];
        let cutCalls = 0;
        const generate = fakeModel(outputs);
        const counting: typeof generate = async (...args) => {
            const r = await generate(...args);
            if (r.ok && cutCalls++ === 0) return { ...r, diagnostics: { ...r.diagnostics!, finishReason: 'MAX_TOKENS' } };
            return r;
        };
        const { profile, calls } = await extractCvProfile(bigCv, { signal: new AbortController().signal, generate: counting });
        assert.equal(profile.roles.length, 30);
        assert.equal(profile.skills.length, 150);
        assert.equal(calls.length, 1 + parts.length, 'every attempt is counted for cost');
    });

    test('every character of a long CV is inside at least one part', async () => {
        const { splitWindows } = await import('./cv/profile');
        const textLong = Array.from({ length: 2000 }, (_, i) => `line ${i} with some words`).join('\n');
        const parts = splitWindows(textLong, 12_000, 1_500);
        for (let i = 0; i < 2000; i += 37) assert.ok(parts.some((p) => p.includes(`line ${i} with`)), `line ${i}`);
        assert.ok(parts.every((p) => p.length <= 12_000));
    });

    test('merging keeps the strongest source for a skill found twice', async () => {
        const { mergeProfiles, CvTextMatcher } = await import('./cv/profile');
        const matcher = new CvTextMatcher(CV);
        const { profile } = mergeProfiles(
            [
                { skills: [{ name: 'Python', source: 'skills-list', evidence: 'Python, SQL, Power BI' }] },
                { skills: [{ name: 'python', source: 'experience', evidence: 'automated reporting with Python' }] },
            ],
            matcher,
        );
        assert.equal(profile.skills.length, 1);
        assert.equal(profile.skills[0]!.source, 'experience');
    });
}

test('a role with one bare year counts as that year, not up to today', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    assert.equal(experienceYears([{ title: 'Saturday job', start: '2025' }], now).totalMonths, 12);
    assert.equal(experienceYears([{ title: 'Accountant', start: '2019', end: 'present' }], now).totalMonths, 95);
    assert.equal(experienceYears([{ title: 'Nurse', start: 'Jan 2026' }], now).totalMonths, 11);
});

test('a CV date is never removed as an address, and a real address still is', () => {
    const kept = careerText('Management Accountant, manufacturing group, 2019 to present. Month-end close, budgeting.');
    assert.match(kept, /2019 to present\. Month-end close/);
    assert.doesNotMatch(careerText('Lives at 12 St. Mary Road, Leeds.'), /12 St\. Mary Road/);
    assert.doesNotMatch(careerText('Lives at 45B Hill Close.'), /45B Hill Close/);
});
