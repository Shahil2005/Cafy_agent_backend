import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    chatSearchSchema,
    interpretJobChatRules,
    jobChatInputSchema,
    normalizeInterpretedChatIntent,
    type ChatSearch,
} from './chatIntent';
import { runJobChat } from './chatService';

const scoped = (): ChatSearch =>
    chatSearchSchema.parse({
        role: 'analyst',
        where: 'London',
        kind: 'career',
        employerScope: 'civil-service',
        jobTypes: ['Full-time'],
        levels: ['Junior'],
        workingArrangement: 'hybrid',
        salary: { min: 30_000, currency: 'GBP', period: 'year' },
        sponsorship: 'advert-confirmed',
    });
const interpret = (message: string, previous: ChatSearch = scoped()) =>
    interpretJobChatRules(jobChatInputSchema.parse({ message, search: previous }));

for (const message of [
    'not only civil service any software jobs',
    'Not just Civil Service, any software jobs please',
    'software jobs, not only Civil Service',
    'any software jobs, not just the Civil Service',
    'software jobs not limited to Civil Service',
    'software jobs not restricted to the Civil Service',
    'software jobs, not Civil Service only',
    'not only Civil Service, but any software jobs',
    'not only Civil Service—any software jobs',
]) {
    test(`explicit scope broadening consumes scope language and retains occupation: ${message}`, () => {
        const previous = scoped();
        const result = interpret(message, previous);
        assert.deepEqual(result.search, { ...previous, role: 'software', employerScope: 'any' });
        assert.equal(result.requiresClarification, undefined);
    });
}

for (const message of ['not only Civil Service', 'not just the Civil Service']) {
    test(`scope-only broadening preserves the previous occupation: ${message}`, () => {
        const previous = scoped();
        const result = interpret(message, previous);
        assert.deepEqual(result.search, { ...previous, employerScope: 'any' });
        assert.equal(result.requiresClarification, undefined);
    });
}

for (const message of [
    'software jobs in both public and private sectors',
    'software jobs across both private and public sectors',
    'software jobs across all sectors',
    'software jobs in any sector',
]) {
    test(`both employer sectors means no employer scope restriction: ${message}`, () => {
        const previous = scoped();
        const result = interpret(message, previous);
        assert.deepEqual(result.search, { ...previous, role: 'software', employerScope: 'any' });
        assert.equal(result.requiresClarification, undefined);
    });
}

test('an explicit any-employer request clears the previous named employer and institution', () => {
    const previous = { ...scoped(), employer: 'DWP' };
    const result = interpret('any software jobs at any employer', previous);
    assert.deepEqual(result.search, { ...previous, role: 'software', employer: '', employerScope: 'any' });
    assert.equal(result.requiresClarification, undefined);
});

test('broadening the previous named employer preserves unrelated criteria', () => {
    const previous = { ...scoped(), employer: 'NHS', employerScope: 'any' as const };
    const result = interpret('not only NHS, any software jobs', previous);
    assert.deepEqual(result.search, { ...previous, role: 'software', employer: '' });
    assert.equal(result.requiresClarification, undefined);
});

test('scope broadening works while reconstructing the previous search from user history', () => {
    const result = interpretJobChatRules(
        jobChatInputSchema.parse({
            message: 'not only civil service any software jobs',
            history: [{ role: 'user', content: 'Civil Service analyst jobs in London' }],
        }),
    );
    assert.deepEqual(
        result.search,
        chatSearchSchema.parse({ role: 'software', where: 'London', kind: 'career' }),
    );
    assert.equal(result.requiresClarification, undefined);
});

test('a model cannot reapply a cleared Civil Service scope or pollute the occupation with broadening words', () => {
    const input = jobChatInputSchema.parse({
        message: 'not only civil service any software jobs',
        search: scoped(),
    });
    const baseline = interpretJobChatRules(input);
    const normalized = normalizeInterpretedChatIntent(
        { ...baseline.search, role: 'not any software', employerScope: 'civil-service', needsClarification: false },
        input,
        baseline,
    );
    assert.equal(normalized?.employerScope, 'any');
    assert.equal(normalized?.role, 'software');
});

for (const message of ['software jobs excluding Civil Service', 'software jobs not Civil Service']) {
    test(`actual employer exclusion is not silently treated as unrestricted broadening: ${message}`, () => {
        const result = interpret(message);
        assert.equal(result.requiresClarification, true);
        assert.ok(result.search.unsupported.includes('excluding Civil Service employers'));
    });
}

test('a narrow public-sector request still needs classification clarification', () => {
    const result = interpret('software jobs in the public sector');
    assert.equal(result.requiresClarification, true);
    assert.ok(result.search.unsupported.includes('public/private sector classification'));
});

test('an ordinary software occupation refinement keeps the explicitly selected institution', () => {
    const previous = scoped();
    const result = interpret('software jobs', previous);
    assert.deepEqual(result.search, { ...previous, role: 'software' });
    assert.equal(result.requiresClarification, undefined);
});

test('sector wording inside an explicit employer name is preserved', () => {
    const previous = scoped();
    const result = interpret('software jobs at All Sectors Ltd', previous);
    assert.deepEqual(result.search, { ...previous, role: 'software', employer: 'All Sectors Ltd' });
    assert.equal(result.requiresClarification, undefined);
});

for (const message of ['software jobs, not all sectors', 'software jobs, not across all sectors']) {
    test(`negated sector wording does not silently remove the institution: ${message}`, () => {
        const result = interpret(message);
        assert.equal(result.search.employerScope, 'civil-service');
        assert.equal(result.requiresClarification, true);
        assert.ok(result.search.unsupported.includes('excluding an employer sector'));
    });
}

test('the corrected criteria reach catalogue, employer sites and Google through the conversation service', async () => {
    const previous = { ...scoped(), employer: 'DWP', sponsorship: 'any' as const };
    const expected = { ...previous, role: 'software', employer: '', employerScope: 'any' };
    const received: string[] = [];
    const verify = (source: string, search: ChatSearch, country = 'uk') => {
        assert.deepEqual(search, expected);
        assert.equal(country, 'uk');
        received.push(source);
    };
    const result = await runJobChat(
        jobChatInputSchema.parse({
            message: 'not only civil service any software jobs',
            search: previous,
            includeWeb: true,
        }),
        { catalogCountry: 'uk', careerPremium: true, partTimePremium: true, partTimeBlocked: false },
        {
            interpret: async () => ({
                ...previous,
                role: 'not any software',
                needsClarification: false,
            }),
            careerFeed: async (search) => {
                verify('catalogue', search);
                return { jobs: [], totalCount: 0, totalPages: 1, globalTotalCount: 0 };
            },
            partTimeFeed: async () => {
                assert.fail('The search must remain in the career catalogue');
            },
            webFeed: async (search, country) => {
                verify('employer-sites', search, country);
                return {
                    jobs: [], examined: 0, excluded: 0, cacheHit: false,
                    retrievedAt: '2026-10-28T00:00:00Z',
                };
            },
            groundedSearch: async (search, country) => {
                verify('google', search, country);
                return {
                    text: '{"cards":[]}', format: 'job-cards', cards: [],
                    sources: [], citations: [], searchQueries: ['software London'], searchSuggestions: [],
                    retrievedAt: '2026-10-28T00:00:00Z',
                };
            },
        },
    );
    assert.deepEqual(received.sort(), ['catalogue', 'employer-sites', 'google']);
    assert.equal(result.mode, 'search');
    assert.equal(result.groundedWebStatus, 'searched');
    assert.deepEqual(result.search, expected);
    assert.doesNotMatch(result.message, /Civil Service|not any software/);
});
