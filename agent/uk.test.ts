import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { cleanAnswer, repeats, withoutUnverifiedFigures } from './agent';
import type { AgentBlock } from './contract';
import { isCvSummaryRequest } from './cvIntent';
import { upgradeSkillSources } from './cv';
import type { CvProfile } from './cv/profile';
import { createFeedbackHandler } from './feedback';
import { CV_TOOLS } from './tools/cv';
import { createSocChooser } from './tools/socChoice';
import { socApplicantRules, createUkTools, socDetails, socSummary, socThresholds } from './tools/uk';

function ctx(extra: Partial<{ showCvCard: boolean; cv: any }> = {}) {
    const blocks: AgentBlock[] = [];
    return { blocks, ctx: { uid: 'u1', signal: new AbortController().signal, cv: null, emit: (_id: string, b: AgentBlock) => blocks.push(b), ...extra } };
}

test('SOC codes and visa pay figures not in official data are removed from the AI text', () => {
    const official = JSON.stringify([{ result: { code: '2134', generalThreshold: 41700, hourly: 17.69 } }]);
    const check = (text: string, pieces: any[] = [], evidence = official) => withoutUnverifiedFigures({ text, pieces }, evidence);

    assert.equal(check('SOC 2134 fits. The threshold is £41,700 or £17.69 an hour.').text, 'SOC 2134 fits. The threshold is £41,700 or £17.69 an hour.');
    const wrongCode = check('SOC code 9999 fits you. Ask your employer.').text;
    assert.doesNotMatch(wrongCode, /9999/);
    assert.match(wrongCode, /Ask your employer\./);
    assert.match(wrongCode, /official data/);
    assert.doesNotMatch(check('The Skilled Worker going rate is £52,000. Check GOV.UK.').text, /52,000/);
    assert.doesNotMatch(check('For a visa you need £41,700 (SOC 7777).').text, /7777/);

    assert.doesNotMatch(check('The minimum wage is £11.44 an hour.').text, /11\.44/, 'a wage rate from memory');
    assert.equal(check('Data analysts often earn around £35,000.').text, 'Data analysts often earn around £35,000.', 'not a visa figure');
    assert.equal(check('Is £38,700 enough for a visa? It depends on the job.', [], 'Is £38,700 enough').text, 'Is £38,700 enough for a visa? It depends on the job.', "the user's own figure can be repeated");

    const out = check('Here you go.', [{ type: 'paragraph', text: 'The visa threshold is £99,999.' }, { type: 'paragraph', text: 'Keep going.' }]);
    assert.deepEqual(out.pieces.map((p) => p.type === 'paragraph' && p.text), ['Keep going.']);
    assert.equal(out.text, 'Here you go.');
});

test('with an official card on screen, the AI does not restate or explain figures', () => {
    const text = 'SOC 8215 covers driving instructors. The new entrant rate is £33,400, which is 70% of the going rate. Check the rules on GOV.UK.';
    const out = withoutUnverifiedFigures({ text, pieces: [] }, '8215 33400', true);
    assert.doesNotMatch(out.text, /33,400|70%/);
    assert.match(out.text, /driving instructors\. Check the rules on GOV\.UK\. The exact figures are in the official card below\./);
    assert.equal(withoutUnverifiedFigures({ text, pieces: [] }, '8215 33400', false).text, text, 'no card: checked against the data only');
});

test('SOC 8215 shows only options that exist, with the official table figures', () => {
    const t = socThresholds('8215');
    assert.deepEqual(t.map((x) => x.option), ['A', 'E', 'F', 'J']);
    assert.deepEqual(t.find((x) => x.option === 'A'), { ...t.find((x) => x.option === 'A')!, floorSalary: 41700, goingRate: 39500, threshold: 41700 });
    assert.equal(t.find((x) => x.option === 'E')!.threshold, 33400);
    assert.equal(t.find((x) => x.option === 'F')!.threshold, 33300);
    assert.equal(t.some((x) => x.option === 'D'), false, 'not on the Immigration Salary List');
    assert.match(socSummary('8215')!.note, /before 22 July 2025/);
    assert.equal(socThresholds('2134').find((x) => x.option === 'G')!.threshold, 36000, 'option G exists');
});

test('SOC for a title that is not official gets the same choice step; an official title does not need it', async () => {
    let asked = 0;
    const [soc] = createUkTools({ match: async () => [{ soc_code: '3433', similarity: 0.85 }, { soc_code: '8215', similarity: 0.85 }, { soc_code: '2431', similarity: 0.8 }], choose: async () => { asked++; return ['2431']; } });
    const out = (await soc!.run({ query: 'Lean Consultant' }, ctx().ctx)) as { options: Array<{ code: string }> };
    assert.deepEqual(out.options.map((o) => o.code), ['2431']);
    assert.equal(asked, 1);
    await soc!.run({ query: 'software engineer' }, ctx().ctx);
    assert.equal(asked, 1);
});

test('options H, I and J state the same date limit as F and G', () => {
    for (const t of socThresholds('2134').filter((x) => 'FGHJ'.includes(x.option))) assert.match(t.condition, /before 4 April 2024/, t.option);
});

test('new applicant rules follow the official lists and their dates', () => {
    const before = Date.parse('2026-11-05');
    const after = Date.parse('2027-01-01');
    const shortage = socApplicantRules('3132', before);
    assert.match(shortage.newApplicants, /^Open through the Temporary Shortage List/);
    assert.match(shortage.newApplicants, /before 31 December 2026/);
    assert.match(socApplicantRules('3549', before).newApplicants, /only for: Business support officers/, 'job type limits are stated');
    assert.match(socApplicantRules('3132', after).newApplicants, /^Not normally/, 'the list closes on its official date');
    assert.match(socApplicantRules('6131', before).newApplicants, /^Open through the Immigration Salary List.*before 31 December 2026/);
    assert.match(socApplicantRules('6131', after).newApplicants, /^Not normally/, 'a job leaves the list on its removal date');
    assert.match(socApplicantRules('8215', before).newApplicants, /^Not normally/);
    const care = socApplicantRules('6135', before);
    assert.match(care.newApplicants, /^Only for applications to stay in the UK/);
    assert.equal(socSummary('6135')!.eligible, null);
    const pre2024 = socApplicantRules('9252', before);
    assert.equal(pre2024.newApplicants, 'Not open to new applicants');
    assert.match(pre2024.existingHolders, /before 4 April 2024/);
    const warehouse = socSummary('9252')!;
    assert.equal(warehouse.eligible, false, 'in official Table 6');
    assert.equal(warehouse.skillLevel, null, 'no skill level is stated officially');
    assert.doesNotMatch(warehouse.note, /Higher-skilled/);
});

test('the Temporary Shortage List file holds only real codes from the official list', () => {
    const list = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'uk_temporary_shortage_list.json'), 'utf8')) as { entries: Array<{ code: string; title: string }> };
    assert.equal(list.entries.length, 52);
    for (const entry of list.entries) assert.equal(socSummary(entry.code)!.title.replace(/\.$/, ''), entry.title);
});

test('SOC cards state who can use the code', async () => {
    const [soc, visa] = createUkTools({ match: async () => [], choose: async () => null });
    const one = ctx();
    await soc!.run({ query: 'SOC 8215' }, one.ctx);
    const card = (one.blocks[0] as Extract<AgentBlock, { kind: 'socCards' }>).card.options[0]!;
    assert.match(card.newApplicants, /Not normally/);
    assert.match(card.existingHolders, /before 22 July 2025/);
    const two = ctx();
    await visa!.run({ socCode: '2134' }, two.ctx);
    const facts = (two.blocks.find((b) => b.kind === 'officialFacts') as Extract<AgentBlock, { kind: 'officialFacts' }>).card.facts;
    assert.equal(facts[0]!.label, 'New applicants');
    assert.equal(facts[0]!.value, 'Open to new applicants');
    assert.equal(facts[1]!.value, 'Open to existing');
});

test('SOC full details: useful official fields only, and nothing that does not apply', async () => {
    const eng = socDetails('8215')!;
    assert.equal(eng.phdEligible, false);
    assert.deepEqual(eng.routes, ['Skilled Worker'], 'Table 2aa codes are not for Global Business Mobility or Scale-up');
    assert.ok(eng.jobTitles.length > 0 && !eng.salaryList && !eng.payScales);
    assert.deepEqual(socDetails('2134')!.routes, ['Skilled Worker', 'Global Business Mobility', 'Scale-up']);
    const listed = socDetails('1212')!;
    assert.equal(listed.salaryList![0]!.where, 'Scotland');
    assert.equal(listed.salaryList![0]!.until, '31 December 2026');
    const doctor = socDetails('2211')!;
    assert.match(doctor.payScales![0]!.text, /£36,616/);
    assert.doesNotMatch(doctor.payScales![0]!.text, /\|/);
    assert.match(socSummary('1112')!.note, /Not eligible/);
    assert.ok(socDetails('2134')!.jobTitles.length <= 150);
    const [, visa] = createUkTools({ match: async () => [], choose: async () => null });
    const { blocks, ctx: context } = ctx();
    const out = (await visa!.run({ socCode: '8215' }, context)) as { occupation: { details: { jobTitles?: string[] } } };
    assert.equal(out.occupation.details.jobTitles, undefined, 'long lists stay out of the AI step');
    const card = blocks.find((b) => b.kind === 'officialFacts') as Extract<AgentBlock, { kind: 'officialFacts' }>;
    assert.ok(card.card.details!.jobTitles.length > 0);
    assert.match(card.card.facts.find((f) => f.label === 'Option A')!.note!, /£20\.26 an hour/);
    assert.equal(card.card.facts.some((f) => f.label === 'Option B'), false);
});

test('a SOC code the user names is looked up directly, never searched for', async () => {
    let searched = 0;
    const [soc] = createUkTools({ match: async () => { searched++; return []; }, choose: async () => null });
    const { blocks, ctx: context } = ctx();
    const out = (await soc!.run({ query: 'SOC 2134' }, context)) as { options: Array<{ code: string }>; lowConfidence?: boolean };
    assert.deepEqual(out.options.map((o) => o.code), ['2134']);
    assert.equal(out.lowConfidence, undefined);
    assert.equal(searched, 0);
    assert.equal(blocks[0]!.kind, 'socCards');
    assert.equal(((await soc!.run({ query: '9999' }, ctx().ctx)) as { error: string }).error, 'UNKNOWN_SOC');
    assert.deepEqual(((await soc!.run({ query: 'soc 21 34' }, ctx().ctx)) as { options: Array<{ code: string }> }).options.map((o) => o.code), ['2134'], 'a space in the code');
});

const leanCv = {
    name: 'CV.pdf',
    text: 'x',
    chunks: [{ index: 0, section: 'Experience', text: 'Ran Kaizen workshops and line balancing in car parts factories.' }],
    profile: { headline: 'Lean trainer', roles: [{ title: 'Lean Trainer' }, { title: 'Continuous Improvement Manager' }], education: [], skills: [], projects: [], achievements: [], certifications: [], languages: [], hasPersonalStatement: false },
};
const nearFitness = async () => [{ soc_code: '3433', similarity: 0.86 }, { soc_code: '3574', similarity: 0.83 }, { soc_code: '1121', similarity: 0.8 }];

test('SOC for a CV: the choice decides the order, a wrong close match is dropped, no percentage is shown', async () => {
    let seen: string[] = [];
    const [soc] = createUkTools({ match: nearFitness, choose: async (_p, candidates) => { seen = candidates.map((c) => c.code); return ['1121', '3574']; } });
    const { blocks, ctx: context } = ctx({ cv: leanCv });
    const out = (await soc!.run({}, context)) as { options: Array<{ code: string; match?: number }>; lowConfidence?: boolean };
    assert.deepEqual(seen, ['3433', '3574', '1121']);
    assert.deepEqual(out.options.map((o) => o.code), ['1121', '3574']);
    assert.equal(out.options[0]!.match, undefined);
    assert.equal(out.lowConfidence, undefined);
    const card = blocks.find((b) => b.kind === 'socCards') as Extract<AgentBlock, { kind: 'socCards' }>;
    assert.deepEqual(card.card.options.map((o) => o.code), ['1121', '3574']);
});

test('SOC for a CV: no fit gives no card, a failed choice is flagged as weak, a failed title search is survived', async () => {
    const none = ctx({ cv: leanCv });
    const [noFit] = createUkTools({ match: nearFitness, choose: async () => [] });
    assert.equal(((await noFit!.run({}, none.ctx)) as { error?: string }).error, 'NO_MATCH');
    assert.equal(none.blocks.length, 0);

    const [failed] = createUkTools({ match: nearFitness, choose: async () => null });
    const out = (await failed!.run({}, ctx({ cv: leanCv }).ctx)) as { lowConfidence?: boolean; options: Array<{ match?: number }> };
    assert.equal(out.lowConfidence, true);
    assert.equal(out.options[0]!.match, 86);

    let calls = 0;
    const flaky = async () => { calls++; if (calls > 1) throw new Error('down'); return nearFitness(); };
    const [survives] = createUkTools({ match: flaky, choose: async () => ['1121'] });
    assert.deepEqual(((await survives!.run({}, ctx({ cv: leanCv }).ctx)) as { options: Array<{ code: string }> }).options.map((o) => o.code), ['1121']);
});

test('SOC chooser only accepts real candidates and treats a bad reply as no choice', async () => {
    const reply = (text: string) => (async () => ({ ok: true, body: { candidates: [{ content: { parts: [{ text }] } }] } })) as never;
    const candidates = [{ code: '1121', title: 'Production managers', examples: [] }, { code: '3574', title: 'Trainers', examples: [] }];
    const person = { headline: 'h', roles: [] };
    const run = (text: string) => createSocChooser(reply(text))(person, candidates, new AbortController().signal);
    assert.deepEqual(await run('{"codes":["3574","9999","3574"]}'), ['3574']);
    assert.deepEqual(await run('{"codes":[]}'), []);
    assert.equal(await run('{"codes":["9999"]}'), null, 'only invented codes');
    assert.equal(await run('not json'), null);
    assert.equal(await run('{"codes":"1121"}'), null);
    const down = createSocChooser((async () => ({ ok: false })) as never);
    assert.equal(await down(person, candidates, new AbortController().signal), null);
});

test('SOC 2134 thresholds are worked out from CAFY data, not typed by hand', () => {
    const summary = socSummary('2134')!;
    assert.equal(summary.title, 'Programmers and software development professionals');
    assert.equal(summary.eligible, true);
    const t = socThresholds('2134');
    const general = t.find((x) => x.option === 'A')!;
    const newEntrant = t.find((x) => x.option === 'E')!;
    assert.equal(general.threshold, Math.max(general.floorSalary, general.goingRate));
    assert.equal(general.floorSalary, 41700);
    assert.equal(newEntrant.floorSalary, 33400);
    assert.equal(newEntrant.threshold, Math.max(33400, newEntrant.goingRate));
    assert.equal(socSummary('2136')!.title, 'IT quality and testing professionals');
});

test('soc_lookup ranks by similarity, joins official data and shows SOC cards', async () => {
    const [socLookup] = createUkTools({ match: async () => [
        { soc_code: '2136', similarity: 0.61 },
        { soc_code: '2134', similarity: 0.83 },
        { soc_code: '2134', similarity: 0.7 },
        { soc_code: '2133', similarity: 0.66 },
    ] });
    const { blocks, ctx: c } = ctx();
    const result = (await socLookup!.run({ query: 'full stack software developer' }, c)) as { options: Array<{ code: string; match: number }> };
    assert.deepEqual(result.options.map((o) => o.code), ['2134', '2133', '2136']);
    assert.equal(result.options[0]!.match, 83);
    assert.equal(blocks[0]!.kind, 'socCards');
});

test('soc_lookup without a query or CV asks for one instead of guessing', async () => {
    const [socLookup] = createUkTools({ match: async () => [] });
    const { ctx: c } = ctx();
    assert.equal(((await socLookup!.run({}, c)) as { error: string }).error, 'NEED_QUERY_OR_CV');
});

test('visa_salary_rules gives current floors with source and date', async () => {
    const [, visa] = createUkTools({ match: async () => [] });
    const { blocks, ctx: c } = ctx();
    await visa!.run({}, c);
    const card = (blocks[0] as Extract<AgentBlock, { kind: 'officialFacts' }>).card;
    assert.equal(card.facts[0]!.value, '£41,700');
    assert.match(card.source.url, /gov\.uk/);
    assert.ok(card.source.date.length > 3);
    const withSoc = ctx();
    await visa!.run({ socCode: '2134' }, withSoc.ctx);
    const socCard = (withSoc.blocks[0] as Extract<AgentBlock, { kind: 'officialFacts' }>).card;
    assert.match(socCard.title, /2134/);
});

test('a paragraph that repeats the answer is removed', () => {
    const text = 'The Skilled Worker visa requires a job offer from a licensed sponsor and the role must meet skill and salary thresholds.';
    assert.equal(repeats('The Skilled Worker visa requires a job offer from a licensed sponsor and salary thresholds.', text), true);
    assert.equal(repeats('Check the register of licensed sponsors on GOV.UK before applying.', text), false);
    const out = cleanAnswer({ text, ui: [{ type: 'paragraph', text }, { type: 'steps', items: ['Check the register'] }], suggestions: [] });
    assert.deepEqual(out.pieces.map((p) => p.type), ['steps']);
});

test('the CV card is shown only for an overview request', async () => {
    const tool = CV_TOOLS.find((t) => t.name === 'get_cv_profile')!;
    const cv = { name: 'CV.pdf', text: 'x', chunks: [], profile: { headline: 'h', roles: [], education: [], skills: [], projects: [], achievements: [], certifications: [], languages: [], hasPersonalStatement: false } };
    const quiet = ctx({ cv });
    await tool.run({}, quiet.ctx);
    assert.equal(quiet.blocks.length, 0);
    const loud = ctx({ cv, showCvCard: true });
    await tool.run({}, loud.ctx);
    assert.equal(loud.blocks[0]!.kind, 'cvProfile');
    assert.equal(isCvSummaryRequest('Summarise my CV'), true);
    assert.equal(isCvSummaryRequest("what's in my resume?"), true);
    assert.equal(isCvSummaryRequest('Which SOC code fits my CV?'), false);
});

test('skills used inside internships are labelled as work experience by code', () => {
    const profile: CvProfile = {
        headline: 'h', roles: [], education: [], projects: [], achievements: [], certifications: [], languages: [], hasPersonalStatement: false,
        skills: [
            { name: 'React.js', source: 'skills-list', evidence: 'React.js' },
            { name: 'MongoDB', source: 'skills-list', evidence: 'MongoDB' },
            { name: 'C++', source: 'skills-list', evidence: 'C++' },
        ],
    };
    const out = upgradeSkillSources(profile, [
        { section: 'Experience', text: 'Software Developer Intern, Starlabs\nBuilt dashboards in React.js and Express.js' },
        { section: 'Projects', text: 'Chat app using MongoDB and Socket.io' },
        { section: 'Skills', text: 'C++, Java, React.js, MongoDB' },
    ]);
    assert.deepEqual(out.skills.map((s) => s.source), ['experience', 'project', 'skills-list']);
});

test('feedback accepts only a valid rating for an answer', async () => {
    const saved: unknown[] = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { uid: 'u1' }; next(); });
    app.post('/f', createFeedbackHandler(async (_uid, entry) => { saved.push(entry); }));
    const server = app.listen(0);
    try {
        const { port } = server.address() as AddressInfo;
        const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/f`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal((await post({ conversationId: 'abcdef123456', answerIndex: 2, rating: 'down', reason: 'wrong' })).status, 204);
        assert.equal((await post({ conversationId: 'abcdef123456', answerIndex: 2, rating: 'meh' })).status, 400);
        assert.equal(saved.length, 1);
    } finally {
        server.close();
    }
});

test('an official job title lifts its SOC code above noisy similarity matches', async () => {
    const [socLookup] = createUkTools({ match: async () => [{ soc_code: '5244', similarity: 0.9 }, { soc_code: '2134', similarity: 0.85 }] });
    const { ctx: c } = ctx();
    const result = (await socLookup!.run({ query: 'Software Engineer' }, c)) as { options: Array<{ code: string }> };
    assert.equal(result.options[0]!.code, '2134');
});

test('answer pieces that repeat codes or figures already shown in a card are dropped', async () => {
    const { withoutCardRepeats } = await import('./agent');
    const shown: AgentBlock[] = [{ kind: 'socCards', card: { options: [{ code: '2134', title: 'Programmers', skillLevel: 'RQF6+', eligible: true, newApplicants: 'Open', existingHolders: 'Open', note: '', examples: [], match: 90 }], source: { label: 'x', url: 'https://www.gov.uk', date: 'July 2026' } } }];
    const kept = withoutCardRepeats([
        { type: 'list', items: [{ title: '2134 Programmers', text: 'Software developers' }] },
        { type: 'steps', items: ['Ask your employer which SOC code they will use'] },
    ], shown);
    assert.deepEqual(kept.map((p) => p.type), ['steps']);
});
