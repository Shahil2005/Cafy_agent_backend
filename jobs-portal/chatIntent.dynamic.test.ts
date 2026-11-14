import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    chatSearchSchema,
    interpretJobChatRules,
    jobChatInputSchema,
    modelChatIntentSchema,
    normalizeInterpretedChatIntent,
    parseModelChatIntent,
    type ChatSearch,
} from './chatIntent';

const search = (value: Partial<ChatSearch> = {}): ChatSearch =>
    chatSearchSchema.parse({ role: 'data analyst', where: 'London', kind: 'career', ...value });
const interpret = (message: string, previous?: ChatSearch) =>
    interpretJobChatRules(jobChatInputSchema.parse({ message, ...(previous ? { search: previous } : {}) }));
const rich = search({
    employer: 'NHS',
    jobTypes: ['Full-time'],
    levels: ['Junior'],
    workingArrangement: 'remote',
    salary: { min: 30_000, max: 45_000, currency: 'GBP', period: 'year' },
    sponsorship: 'advert-confirmed',
});

test('legacy search input receives deterministic defaults and rejects unexpected fields', () => {
    const parsed = jobChatInputSchema.parse({
        message: 'Manchester instead',
        search: { role: 'analyst', where: 'London', kind: 'career' },
    });
    assert.deepEqual(parsed.search, search({ role: 'analyst' }));
    assert.equal(chatSearchSchema.safeParse({ ...rich, guessedJobs: [] }).success, false);
    assert.equal(
        chatSearchSchema.safeParse({ ...rich, salary: { min: 45_000, max: 30_000, currency: 'GBP', period: 'year' } })
            .success,
        false,
    );
});

for (const message of [
    'civil service software',
    'CivilService software',
    'Find Civil Service software jobs',
    'Find software jobs in the Civil Service',
    'Find software jobs at Civil Service in London',
]) {
    test(`Civil Service is an institution scope, preserving occupation: ${message}`, () => {
        const result = interpret(message);
        assert.equal(result.search.role, 'software');
        assert.equal(result.search.employerScope, 'civil-service');
        assert.equal(result.search.employer, '');
        assert.equal(result.search.where, message.includes('London') ? 'London' : '');
        assert.equal(result.clarification, undefined);
    });
}

test('scope-only Civil Service searches are meaningful without inventing an occupation', () => {
    const result = interpret('Civil Service jobs');
    assert.equal(result.search.role, '');
    assert.equal(result.search.employerScope, 'civil-service');
    assert.equal(result.clarification, undefined);
});

test('institution scope survives location and occupation refinements', () => {
    const scoped = search({ employerScope: 'civil-service', role: 'software', where: 'London' });
    assert.deepEqual(interpret('Manchester instead', scoped).search, { ...scoped, where: 'Manchester' });
    assert.deepEqual(interpret('What about data analyst jobs', scoped).search, { ...scoped, role: 'data analyst' });
});

test('legacy institution words in an old role are repaired before follow-up searching', () => {
    const legacy = search({ role: 'civil service software', employerScope: 'any', where: 'London' });
    const refined = interpret('Manchester instead', legacy);
    assert.equal(refined.search.role, 'software');
    assert.equal(refined.search.employerScope, 'civil-service');
    assert.equal(refined.search.where, 'Manchester');
});

test('Any employer and explicit scope removal clear only their stated criteria', () => {
    const scoped = search({ employerScope: 'civil-service', employer: 'DWP', role: 'software' });
    assert.deepEqual(interpret('Any employer', scoped).search, { ...scoped, employer: '', employerScope: 'any' });
    for (const message of ['No Civil Service filter', 'Remove the Civil Service scope']) {
        assert.deepEqual(interpret(message, scoped).search, { ...scoped, employerScope: 'any' });
    }
});

test('Civil Service scope does not infer NHS, civil engineering or general public-sector status', () => {
    assert.equal(interpret('Find civil engineering jobs').search.employerScope, 'any');
    assert.equal(interpret('Find NHS software jobs').search.employerScope, 'any');
    const general = interpret('Find software jobs in the public sector');
    assert.equal(general.search.employerScope, 'any');
    assert.ok(general.requiresClarification);
    const excluded = interpret('Find software jobs excluding Civil Service');
    assert.ok(excluded.requiresClarification);
    assert.ok(excluded.search.unsupported.includes('excluding Civil Service employers'));
});

test('model extraction cannot invent or discard the institution scope', () => {
    const request = jobChatInputSchema.parse({ message: 'Find software jobs' });
    const ordinary = interpretJobChatRules(request);
    const invented = normalizeInterpretedChatIntent(
        { ...ordinary.search, employerScope: 'civil-service', needsClarification: false },
        request,
        ordinary,
    );
    assert.equal(invented?.employerScope, 'any');
    const scopedRequest = jobChatInputSchema.parse({ message: 'Civil Service software' });
    const scoped = interpretJobChatRules(scopedRequest);
    const discarded = normalizeInterpretedChatIntent(
        { ...scoped.search, employerScope: 'any', needsClarification: false },
        scopedRequest,
        scoped,
    );
    assert.equal(discarded?.employerScope, 'civil-service');
    assert.equal(discarded?.role, 'software');
});

for (const message of [
    'Find data analyst jobs at NHS in London',
    'Find NHS data analyst jobs in London',
    'Find data analyst jobs in London at NHS',
]) {
    test(`employer AND location: ${message}`, () => {
        assert.deepEqual(interpret(message).search, search({ employer: 'NHS' }));
        assert.equal(interpret(message).clarification, undefined);
    });
}
test('arbitrary explicitly named employers remain separate from location', () => {
    const result = interpret('Find software engineer jobs at Acme Research in Manchester');
    assert.deepEqual(
        result.search,
        search({ role: 'software engineer', employer: 'Acme Research', where: 'Manchester' }),
    );
});
test('NHS employer-only search does not accidentally filter the title', () => {
    const result = interpret('Show me NHS jobs');
    assert.deepEqual(result.search, search({ role: '', where: '', employer: 'NHS' }));
});
for (const message of [
    'Manchester instead',
    'same roles but in Manchester',
    'what about Manchester',
    'in Manchester',
]) {
    test(`location refinement preserves every other constraint: ${message}`, () => {
        assert.deepEqual(interpret(message, rich).search, { ...rich, where: 'Manchester' });
    });
}
test('role refinement changes only role', () => {
    assert.deepEqual(interpret('What about software engineer jobs', rich).search, {
        ...rich,
        role: 'software engineer',
    });
});
for (const [message, field, value] of [
    ['only hybrid', 'workingArrangement', 'hybrid'],
    ['full-time only', 'jobTypes', ['Full-time']],
    ['junior only', 'levels', ['Junior']],
    ['at Google instead', 'employer', 'Google'],
] as const) {
    test(`filter-only refinement preserves role and other constraints: ${message}`, () => {
        assert.deepEqual(interpret(message, rich).search, { ...rich, [field]: value });
    });
}
test('multiple supported types are alternatives within that field', () => {
    assert.deepEqual(interpret('Find full-time or contract data analyst jobs in London').search.jobTypes, [
        'Full-time',
        'Contract',
    ]);
});
test('short part-time refinement retains the previous role', () => {
    assert.deepEqual(
        interpret('part-time only', search()).search,
        search({ kind: 'part-time', jobTypes: ['Part-time'] }),
    );
});
test('new explicit part-time search does not reuse the old career role', () => {
    assert.deepEqual(
        interpret('Find part-time jobs in Manchester', search()).search,
        search({ role: '', where: 'Manchester', kind: 'part-time', jobTypes: ['Part-time'] }),
    );
});
test('full constraints are extracted together without polluting role or city', () => {
    const result = interpret('Find remote graduate analyst jobs in London with salary over £40k and visa sponsorship');
    assert.deepEqual(
        result.search,
        search({
            role: 'analyst',
            levels: ['Entry Level'],
            workingArrangement: 'remote',
            salary: { min: 40_000.01, currency: 'GBP', period: 'year' },
            sponsorship: 'advert-confirmed',
        }),
    );
    assert.equal(result.clarification, undefined);
});
test('salary range and employer parse together with level and type', () => {
    const result = interpret(
        'Find full-time junior remote data analyst jobs at NHS in London paying between £30k and £40k',
    );
    assert.deepEqual(result.search, {
        ...rich,
        sponsorship: 'any',
        salary: { min: 30_000, max: 40_000, currency: 'GBP', period: 'year' },
    });
});
for (const [message, expected] of [
    ['at least £40k', { min: 40_000, currency: 'GBP', period: 'year' }],
    ['salary under £40k', { max: 39_999.99, currency: 'GBP', period: 'year' }],
    ['paying up to £40,000 per year', { max: 40_000, currency: 'GBP', period: 'year' }],
    ['£30-40k', { min: 30_000, max: 40_000, currency: 'GBP', period: 'year' }],
    ['£30k–£40k', { min: 30_000, max: 40_000, currency: 'GBP', period: 'year' }],
    ['paying £15 per hour', { min: 15, max: 15, currency: 'GBP', period: 'hour' }],
    ['at least €3000 per month', { min: 3000, currency: 'EUR', period: 'month' }],
    ['over $50k', { min: 50_000.01, currency: 'USD', period: 'year' }],
] as const) {
    test(`salary units and bounds: ${message}`, () => {
        const result = interpret(message, search());
        assert.deepEqual(result.search.salary, expected);
        assert.equal(result.search.role, 'data analyst');
        assert.equal(result.clarification, undefined);
    });
}
test('a bare salary amount is exact rather than inventing a threshold', () => {
    assert.deepEqual(interpret('£40000', search()).search.salary, {
        min: 40_000,
        max: 40_000,
        currency: 'GBP',
        period: 'year',
    });
});
for (const [message, field, value] of [
    ['Any salary', 'salary', undefined],
    ['Any location', 'where', ''],
    ['Any employer', 'employer', ''],
    ['Any experience level', 'levels', []],
    ['Any job type', 'jobTypes', []],
    ['Any working arrangement', 'workingArrangement', 'any'],
    ['No sponsorship filter', 'sponsorship', 'any'],
    ['No sponsorship needed', 'sponsorship', 'any'],
] as const) {
    test(`explicit clear changes only the named filter: ${message}`, () => {
        const expected = { ...rich, [field]: value };
        if (field === 'salary') delete expected.salary;
        assert.deepEqual(interpret(message, rich).search, expected);
    });
}
test('reset clears all constraints and asks for a useful next query', () => {
    const result = interpret('Start over', rich);
    assert.deepEqual(result.search, search({ role: '', where: '' }));
    assert.match(result.clarification || '', /What job title/);
});
for (const message of [
    'Find data analyst jobs in the public sector',
    'Find analyst jobs within 5 miles of London',
    'Find analyst jobs in London weekends only',
    'Find analyst jobs needing 2 years experience',
    'not remote',
    'not senior',
    'not contract',
    'no experience required',
    'data analyst or business analyst jobs',
    'data analyst jobs with Python and SQL',
    'jobs paying a competitive salary',
    'jobs paying between £50k and £40k',
    'jobs without sponsorship',
    'jobs paying not under £40k',
]) {
    test(`unverifiable criteria block matching: ${message}`, () => {
        const result = interpret(message, search());
        assert.ok(result.search.unsupported.length, message);
        assert.equal(result.requiresClarification, true);
        assert.match(result.clarification || '', /cannot reliably verify/);
    });
}
test('unsupported requirements persist across turns until explicitly removed', () => {
    const first = interpret('Find data analyst jobs in the public sector in London');
    const next = interpret('Manchester instead', first.search);
    assert.deepEqual(next.search.unsupported, first.search.unsupported);
    assert.equal(next.requiresClarification, true);
    const cleared = interpret('Remove unsupported filters', next.search);
    assert.deepEqual(cleared.search.unsupported, []);
    assert.equal(cleared.search.role, 'data analyst');
    assert.equal(cleared.search.where, 'Manchester');
    assert.equal(cleared.clarification, undefined);
});
test('licence search remains distinct from advert-confirmed sponsorship', () => {
    assert.equal(interpret('Find jobs at licensed sponsors in London').search.sponsorship, 'licensed-employer');
    assert.equal(interpret('Find analyst jobs with visa sponsorship in London').search.sponsorship, 'advert-confirmed');
    assert.match(interpret('Find analyst jobs at licensed sponsors in London').notes.join(' '), /does not establish/);
});
test('background requests clarify rather than generating an invented occupation', () => {
    const result = interpret('I am a student with a business degree');
    assert.equal(result.search.role, '');
    assert.match(result.clarification || '', /What job title/);
});
test('history reconstruction considers only users and retains filters across turns', () => {
    const result = interpretJobChatRules(
        jobChatInputSchema.parse({
            message: 'Manchester instead',
            history: [
                { role: 'user', content: 'Find remote data analyst jobs at NHS in London over £40k' },
                { role: 'assistant', content: 'Perhaps senior nurse jobs in Bristol?' },
            ],
        }),
    );
    assert.deepEqual(
        result.search,
        search({
            where: 'Manchester',
            employer: 'NHS',
            workingArrangement: 'remote',
            salary: { min: 40_000.01, currency: 'GBP', period: 'year' },
        }),
    );
});
test('strict model JSON rejects prose, extra payloads and invalid salaries', () => {
    assert.equal(parseModelChatIntent('```json\n{}\n```'), null);
    assert.equal(parseModelChatIntent(JSON.stringify({ ...rich, needsClarification: false, jobs: [] })), null);
    assert.equal(
        parseModelChatIntent(
            JSON.stringify({
                ...rich,
                salary: { min: -1, currency: 'GBP', period: 'year' },
                needsClarification: false,
            }),
        ),
        null,
    );
    assert.deepEqual(parseModelChatIntent(JSON.stringify({ ...rich, needsClarification: false })), {
        ...rich,
        needsClarification: false,
    });
});
test('AI cannot drop filters, reintroduce cleared filters, change employer or silently broaden role', () => {
    const input = jobChatInputSchema.parse({ message: 'Manchester instead', search: rich });
    const baseline = interpretJobChatRules(input);
    const proposed = modelChatIntentSchema.parse({
        role: 'software engineer',
        where: '',
        employer: 'Google',
        kind: 'career',
        needsClarification: false,
    });
    assert.deepEqual(normalizeInterpretedChatIntent(proposed, input, baseline), {
        ...rich,
        where: 'Manchester',
        needsClarification: false,
    });
    const clearInput = jobChatInputSchema.parse({ message: 'Any salary', search: rich });
    const cleared = interpretJobChatRules(clearInput);
    assert.deepEqual(normalizeInterpretedChatIntent({ ...rich, needsClarification: false }, clearInput, cleared), {
        ...cleared.search,
        needsClarification: false,
    });
});

test('small salary amounts require an explicit pay period', () => {
    const result = interpret('jobs paying £15', search());
    assert.equal(result.search.salary, undefined);
    assert.equal(result.requiresClarification, true);
});
test('currency codes work alongside currency symbols', () => {
    assert.deepEqual(interpret('salary over GBP 40k', search()).search.salary, {
        min: 40_000.01,
        currency: 'GBP',
        period: 'year',
    });
    assert.deepEqual(interpret('paying EUR 3000 per month', search()).search.salary, {
        min: 3000,
        max: 3000,
        currency: 'EUR',
        period: 'month',
    });
});
test('inferred annual salary units are visible in the response notes', () => {
    assert.match(interpret('salary over £40k', search()).notes.join(' '), /GBP per year/);
});
test('unsupported skills are not mixed into role or city when user explicitly removes them', () => {
    for (const message of [
        'Find data analyst jobs with Python and SQL in London',
        'Find data analyst jobs in London with Python and SQL',
    ]) {
        const blocked = interpret(message);
        assert.equal(blocked.requiresClarification, true);
        assert.equal(blocked.search.role, 'data analyst');
        assert.equal(blocked.search.where, 'London');
        const cleared = interpret('Remove unsupported filters', blocked.search);
        assert.deepEqual(cleared.search, search());
    }
});
test('unsupported sector and exact experience do not contaminate remaining role/location filters', () => {
    const sector = interpret('Find data analyst jobs in the public sector in London');
    assert.equal(sector.search.role, 'data analyst');
    assert.equal(sector.search.where, 'London');
    const experience = interpret('Find data analyst jobs needing 2 years experience in London');
    assert.equal(experience.search.role, 'data analyst');
    assert.equal(experience.search.where, 'London');
});
test('AI may remove conversational filler from a new grounded role without dropping substantive words', () => {
    const input = jobChatInputSchema.parse({ message: 'I would like a data analyst job in London' });
    const baseline = interpretJobChatRules(input);
    const model = modelChatIntentSchema.parse({
        role: 'data analyst',
        where: 'London',
        kind: 'career',
        needsClarification: false,
    });
    assert.equal(normalizeInterpretedChatIntent(model, input, baseline)?.role, 'data analyst');
    assert.equal(
        normalizeInterpretedChatIntent({ ...model, role: 'analyst' }, input, baseline)?.role,
        baseline.search.role,
    );
    assert.equal(
        normalizeInterpretedChatIntent({ ...model, role: 'software engineer' }, input, baseline)?.role,
        baseline.search.role,
    );
});
test('model-discovered unsupported requirements force clarification and retain every explicit criterion', () => {
    const input = jobChatInputSchema.parse({ message: 'Manchester instead', search: rich });
    const baseline = interpretJobChatRules(input);
    const result = normalizeInterpretedChatIntent(
        { ...rich, unsupported: ['a professional registration requirement'], needsClarification: false },
        input,
        baseline,
    );
    assert.deepEqual(result, {
        ...rich,
        where: 'Manchester',
        unsupported: ['a professional registration requirement'],
        needsClarification: true,
    });
});

for (const message of ['show more', 'more results', 'next page', 'load more', 'show me more jobs', 'page 2']) {
    test(`pagination requests clarify instead of replaying the first page: ${message}`, () => {
        const result = interpret(message, rich);
        assert.equal(result.requiresClarification, true);
        assert.match(result.clarification || '', /currently shows one results page/);
        assert.deepEqual(result.search, rich);
    });
}

test('Contract Manager is an occupation, not a contract-only job filter', () => {
    const result = interpret('Find contract manager jobs in London');
    assert.equal(result.search.role, 'contract manager');
    assert.deepEqual(result.search.jobTypes, []);
    assert.equal(result.clarification, undefined);
});
for (const employer of ['Senior Plc', 'Full Time Group', 'John Lewis and Partners']) {
    test(`employer names are protected from filter keyword interpretation: ${employer}`, () => {
        const result = interpret(`Find jobs at ${employer} in London`);
        assert.equal(result.search.employer, employer);
        assert.equal(result.search.where, 'London');
        assert.deepEqual(result.search.levels, []);
        assert.deepEqual(result.search.jobTypes, []);
    });
}
test('employer alternatives clarify without persisting an invalid combined employer', () => {
    const result = interpret('Find analyst jobs at Google or Amazon in London', search());
    assert.equal(result.requiresClarification, true);
    assert.ok(result.search.unsupported.includes('multiple alternative employers'));
    assert.equal(result.search.employer, '');
});
test('common with/for employer phrasing works without treating student skills as an employer', () => {
    assert.equal(interpret('Find jobs with NHS in London').search.employer, 'NHS');
    assert.equal(interpret('Find jobs for Google in London').search.employer, 'Google');
    assert.equal(interpret('Find jobs for data analysts in London').search.employer, '');
    assert.equal(interpret('Find jobs for data analysts in London').search.role, 'data analysts');
});
for (const message of [
    "Don't show remote jobs",
    'exclude remote jobs',
    "I don't want contract roles",
    'Not in London',
    'Find jobs not at Google',
]) {
    test(`negation never becomes a positive filter or contaminates current search: ${message}`, () => {
        const result = interpret(message, rich);
        assert.equal(result.requiresClarification, true);
        assert.deepEqual({ ...result.search, unsupported: [] }, rich);
    });
}
for (const message of [
    'Find jobs for 20h/week in London',
    'Find jobs for twenty hours a week',
    'Find jobs during term time',
    'Find analyst jobs requiring two years experience in London',
]) {
    test(`unstructured time requirements are blocked: ${message}`, () => {
        const result = interpret(message);
        assert.equal(result.requiresClarification, true);
        assert.equal(result.search.employer, '');
        assert.ok(result.search.unsupported.length);
        assert.doesNotMatch(result.search.role, /20h|twenty hours|term time|two years/);
    });
}
for (const message of [
    'I have a degree in computer science and need a job in London',
    "I'm a student looking for jobs in London",
]) {
    test(`background without a requested occupation clarifies: ${message}`, () => {
        const result = interpret(message, rich);
        assert.equal(result.requiresClarification, true);
        assert.match(result.clarification || '', /What job title/);
        assert.deepEqual(result.search, rich);
    });
}
test('background plus an explicit requested role searches that role only', () => {
    const result = interpret("I'm a student looking for analyst jobs in London");
    assert.equal(result.search.role, 'analyst');
    assert.equal(result.search.where, 'London');
    assert.equal(result.clarification, undefined);
});
for (const [message, field, value] of [
    ['remove the location filter', 'where', ''],
    ['remove the employer filter', 'employer', ''],
    ['ignore salary', 'salary', undefined],
    ["I don't need visa sponsorship", 'sponsorship', 'any'],
] as const) {
    test(`natural filter removals retain every other field: ${message}`, () => {
        const expected = { ...rich, [field]: value };
        if (field === 'salary') delete expected.salary;
        assert.deepEqual(interpret(message, rich).search, expected);
    });
}
test('national and anywhere phrases never become a literal location the', () => {
    const result = interpret('Find fully remote jobs from anywhere in the UK', search());
    assert.equal(result.search.where, '');
    assert.equal(result.search.workingArrangement, 'remote');
    assert.equal(result.search.role, 'data analyst');
});
for (const [message, expected] of [
    ['more than £40000', { min: 40000.01 }],
    ['less than £40000', { max: 39999.99 }],
    ['above £40000', { min: 40000.01 }],
    ['below £40000', { max: 39999.99 }],
    ['at least £40000', { min: 40000 }],
    ['at most £40000', { max: 40000 }],
    ['no less than £40000', { min: 40000 }],
    ['no more than £40000', { max: 40000 }],
] as const) {
    test(`salary comparison preserves strict versus inclusive meaning: ${message}`, () => {
        const result = interpret(`I want jobs paying ${message}`, search());
        assert.deepEqual(result.search.salary, { ...expected, currency: 'GBP', period: 'year' });
        assert.equal(result.search.role, 'data analyst');
    });
}

for (const message of ['Find UK jobs', 'Find Irish jobs']) {
    test(`country qualifier is never used as a job title: ${message}`, () => {
        const result = interpret(message);
        assert.equal(result.search.role, '');
        assert.equal(result.requiresClarification, true);
    });
}
for (const [message, expected] of [
    ['Find jobs at Google with remote working', { employer: 'Google', workingArrangement: 'remote' }],
    ['Find jobs at Google fully remote', { employer: 'Google', workingArrangement: 'remote' }],
    ['Find jobs at Google remote only', { employer: 'Google', workingArrangement: 'remote' }],
    ['Find jobs at NHS for full-time roles', { employer: 'NHS', jobTypes: ['Full-time'] }],
] as const) {
    test(`employer clause stops before an explicit filter suffix: ${message}`, () => {
        const result = interpret(message);
        for (const [key, value] of Object.entries(expected))
            assert.deepEqual(result.search[key as keyof ChatSearch], value);
        assert.deepEqual(result.search.unsupported, []);
    });
}
for (const [suffix, expected] of [
    ['or more', { min: 40000 }],
    ['or less', { max: 40000 }],
    ['and above', { min: 40000 }],
    ['and below', { max: 40000 }],
] as const) {
    test(`salary comparison suffix ${suffix} stays out of role keywords`, () => {
        const result = interpret(`Find analyst jobs paying £40k ${suffix}`);
        assert.deepEqual(result.search.salary, { ...expected, currency: 'GBP', period: 'year' });
        assert.equal(result.search.role, 'analyst');
        assert.deepEqual(result.search.unsupported, []);
    });
}

test('AI can identify an employer reading grounded in a brand-only request, requiring explicit confirmation', () => {
    const input = jobChatInputSchema.parse({ message: 'Tesco jobs in London' });
    const baseline = interpretJobChatRules(input);
    const model = modelChatIntentSchema.parse({
        role: '',
        where: 'London',
        employer: 'Tesco',
        kind: 'career',
        needsClarification: false,
    });
    const result = normalizeInterpretedChatIntent(model, input, baseline);
    assert.equal(result?.needsClarification, true);
    assert.match(result?.clarification || '', /“Tesco” as the employer/);
    assert.match(result?.clarification || '', /Find jobs at Tesco in London/);
    assert.deepEqual(
        { ...result, clarification: undefined, needsClarification: undefined },
        { ...baseline.search, clarification: undefined, needsClarification: undefined },
    );
    assert.equal(result?.unsupported.length, 0);
    const { clarification: _clarification, needsClarification: _needsClarification, ...unchangedSearch } = result!;
    const confirmed = interpret('Find jobs at Tesco in London', unchangedSearch);
    assert.equal(confirmed.search.employer, 'Tesco');
    assert.equal(confirmed.search.role, '');
    assert.equal(confirmed.clarification, undefined);
});
test('entity interpretation can split new role words between employer and occupation when all are accounted for', () => {
    const input = jobChatInputSchema.parse({ message: 'Tesco analyst jobs in London' });
    const baseline = interpretJobChatRules(input);
    const model = modelChatIntentSchema.parse({
        role: 'analyst',
        where: 'London',
        employer: 'Tesco',
        kind: 'career',
        needsClarification: false,
    });
    const result = normalizeInterpretedChatIntent(model, input, baseline);
    assert.match(result?.clarification || '', /Find analyst jobs at Tesco in London/);
    assert.equal(result?.role, 'Tesco analyst');
    assert.equal(result?.employer, '');
});
test('location reassignment of current request words requires confirmation without dropping the role', () => {
    const input = jobChatInputSchema.parse({ message: 'London analyst jobs' });
    const baseline = interpretJobChatRules(input);
    const model = modelChatIntentSchema.parse({
        role: 'analyst',
        where: 'London',
        employer: '',
        kind: 'career',
        needsClarification: false,
    });
    const result = normalizeInterpretedChatIntent(model, input, baseline);
    assert.match(result?.clarification || '', /“London” as the location/);
    assert.match(result?.clarification || '', /Find analyst jobs in London/);
    assert.equal(result?.role, 'London analyst');
    assert.equal(result?.where, '');
});
test('ordinary occupations cannot be reassigned to an employer by AI', () => {
    const input = jobChatInputSchema.parse({ message: 'Find data analyst jobs in London' });
    const baseline = interpretJobChatRules(input);
    const model = modelChatIntentSchema.parse({
        role: '',
        where: 'London',
        employer: 'data analyst',
        kind: 'career',
        needsClarification: false,
    });
    const result = normalizeInterpretedChatIntent(model, input, baseline);
    assert.equal(result?.clarification, undefined);
    assert.equal(result?.needsClarification, false);
    assert.equal(result?.role, 'data analyst');
    assert.equal(result?.employer, '');
});
test('entity reassignment cannot omit words, invent an employer or use an entity absent from the current request', () => {
    const input = jobChatInputSchema.parse({ message: 'Tesco analyst jobs in London' });
    const baseline = interpretJobChatRules(input);
    for (const fields of [
        { role: '', employer: 'Tesco' },
        { role: 'analyst', employer: 'Google' },
        { role: 'analyst', employer: 'Tesco Plc' },
    ]) {
        const model = modelChatIntentSchema.parse({
            ...fields,
            where: 'London',
            kind: 'career',
            needsClarification: false,
        });
        const result = normalizeInterpretedChatIntent(model, input, baseline);
        assert.equal(result?.clarification, undefined);
        assert.equal(result?.employer, '');
        assert.equal(result?.role, 'Tesco analyst');
    }
});
test('entity clarification retains active prior employer and every hard filter until explicitly confirmed', () => {
    const input = jobChatInputSchema.parse({ message: 'Tesco jobs in London', search: rich });
    const baseline = interpretJobChatRules(input);
    const model = modelChatIntentSchema.parse({
        role: '',
        employer: 'Tesco',
        where: 'London',
        kind: 'career',
        needsClarification: false,
    });
    const result = normalizeInterpretedChatIntent(model, input, baseline);
    assert.ok(result?.clarification);
    assert.equal(result?.employer, 'NHS');
    assert.deepEqual(result?.salary, rich.salary);
    assert.deepEqual(result?.jobTypes, rich.jobTypes);
    assert.deepEqual(result?.levels, rich.levels);
    assert.equal(result?.workingArrangement, rich.workingArrangement);
    assert.equal(result?.sponsorship, rich.sponsorship);
});
test('filter-only turns cannot reassign the previous occupation to an employer', () => {
    const previous = search({ role: 'Tesco' });
    const input = jobChatInputSchema.parse({ message: 'Manchester instead', search: previous });
    const baseline = interpretJobChatRules(input);
    const model = modelChatIntentSchema.parse({
        role: '',
        employer: 'Tesco',
        where: 'Manchester',
        kind: 'career',
        needsClarification: false,
    });
    const result = normalizeInterpretedChatIntent(model, input, baseline);
    assert.equal(result?.clarification, undefined);
    assert.equal(result?.role, 'Tesco');
    assert.equal(result?.employer, '');
});
