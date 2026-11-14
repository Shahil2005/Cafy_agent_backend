import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import {
    buildServerControlledPayload,
    callGemini,
    readGoogleSearchGrounding,
    readGoogleUrlContextMetadata,
} from '../ai/geminiCore';
import { executeAiGeneration } from '../ai/orchestrator';
import { parseSecureInput } from '../ai/parseSecureInput';
import { buildGenerationConfig } from '../ai/profiles';
import type { GoogleSearchGrounding, OrchestratorSuccess } from '../ai/types';
import { chatSearchSchema } from './chatIntent';
import {
    ChatGoogleWebError,
    hasSufficientChatCitationCoverage,
    searchChatGoogleWeb,
    parseOriginalGoogleJobCards,
    isIndividualGoogleJobUrl,
    isGoogleGroundingSourceUrl,
} from './chatGoogleDiscovery';

const search = chatSearchSchema.parse({
    role: 'data analyst',
    where: 'London',
    employer: 'NHS',
    kind: 'career',
});
const source = 'https://jobs.nhs.uk/candidate/jobadvert/C1234-26-0001';
const originalCard = {
    title: 'Data Analyst',
    employer: 'NHS Employer',
    location: 'London',
    salary: null,
    employmentType: null,
    workingArrangement: null,
    description:
        'The employer advertisement describes data analysis and reporting work.',
    closingDate: '2026-11-02',
    postedDate: '2026-10-20',
    url: source,
    explanation:
        'The advertised title and location correspond to the requested role and city. Confirm availability on the advert.',
};
const text = JSON.stringify({ cards: [originalCard] });
const suggestion = [
    'NHS data analyst London jobs',
    'https://www.google.com/search?q=NHS+data+analyst+London+jobs',
];
const grounding = (): GoogleSearchGrounding => ({
    sources: [{ url: source, title: 'Employer job advert' }],
    citations: [{ startIndex: 0, endIndex: text.length, sourceIndexes: [0] }],
    searchQueries: ['NHS data analyst London jobs'],
    searchSuggestions: [{ label: suggestion[0]!, url: suggestion[1]! }],
});
function success(
    overrides: Partial<OrchestratorSuccess> = {},
): OrchestratorSuccess {
    return {
        ok: true,
        body: { candidates: [{ content: { parts: [{ text }] } }] },
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        attempts: 1,
        latencyMs: 10,
        diagnostics: {
            finishReason: 'STOP',
            promptTokens: 100,
            outputTokens: 30,
        },
        groundingMetadata: grounding(),
        urlContextMetadata: {
            retrievals: [{ url: source, status: 'success' }],
        },
        ...overrides,
    };
}
function candidate(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        content: { parts: [{ text }] },
        urlContextMetadata: {
            urlMetadata: [
                {
                    retrievedUrl: source,
                    urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
                },
            ],
        },
        groundingMetadata: {
            groundingChunks: [
                { web: { uri: source, title: 'Employer job advert' } },
            ],
            webSearchQueries: [suggestion[0]],
            groundingSupports: [
                {
                    segment: {
                        startIndex: 0,
                        endIndex: Buffer.byteLength(text),
                        text,
                    },
                    groundingChunkIndices: [0],
                },
            ],
            searchEntryPoint: {
                sdkBlob: Buffer.from(JSON.stringify([suggestion])).toString(
                    'base64',
                ),
            },
            ...overrides,
        },
    };
}
async function withEnvironment(
    values: Record<string, string>,
    task: () => Promise<void>,
): Promise<void> {
    const previous = Object.fromEntries(
        Object.keys(values).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    try {
        await task();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('the dedicated operation enables native Google Search with a compatible model and JSON schema', () => {
    const payload = buildServerControlledPayload(
        'jobs_web_discovery',
        { contents: [], systemInstruction: {} },
        'gemini-3.5-flash-lite',
    );
    assert.deepEqual(payload.tools, [{ urlContext: {} }]);
    const config = buildGenerationConfig('jobs_web_discovery', {
        model: 'gemini-3.5-flash-lite',
    });
    assert.equal(config.responseMimeType, 'application/json');
    assert.equal(typeof config.responseJsonSchema, 'object');
    assert.equal(config.maxOutputTokens, 3072);
    assert.equal(config.temperature, 0);
    assert.equal(config.thinkingConfig, undefined);
    assert.equal(
        buildGenerationConfig('jobs_search_chat').responseMimeType,
        'application/json',
    );
});

test('the generic AI route cannot be used to bypass the protected chat route', () => {
    const result = parseSecureInput({
        operation: 'jobs_web_discovery',
        input: {},
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'DIRECT_ROUTE_REQUIRED');
});

test('provider attribution retains only safe bounded display metadata', () => {
    assert.deepEqual(readGoogleSearchGrounding(candidate()), grounding());
    assert.equal(readGoogleSearchGrounding({}), undefined);
    const result = readGoogleSearchGrounding(
        candidate({
            webSearchQueries: [
                suggestion[0],
                suggestion[0],
                null,
                'x'.repeat(501),
                '\u0000unsafe',
            ],
            searchEntryPoint: {
                sdkBlob: 'not-a-valid-blob',
                renderedContent: '<script>never execute</script>',
            },
        }),
    );
    assert.deepEqual(result?.searchQueries, [suggestion[0]]);
    assert.deepEqual(result?.searchSuggestions, []);
    assert.equal('searchEntryPoint' in result!, false);
});

test('source links reject local, credentialed, literal IP and non-HTTPS destinations', () => {
    const bad = [
        'javascript:alert(1)',
        'http://jobs.nhs.uk/job',
        'https://localhost/job',
        'https://127.0.0.1/job',
        'https://2130706433/job',
        'https://[::1]/job',
        'https://metadata.google.internal/job',
        'https://foo.home.arpa/job',
        'https://user:password@jobs.nhs.uk/job',
        'https://jobs.nhs.uk:444/job',
        `https://jobs.nhs.uk/${'x'.repeat(2048)}`,
        'https://jobs.nhs.uk/job\nsecret',
    ];
    const result = readGoogleSearchGrounding(
        candidate({
            groundingChunks: bad.map((uri) => ({
                web: { uri, title: 'unsafe' },
            })),
        }),
    );
    assert.deepEqual(result?.sources, []);
    assert.deepEqual(result?.citations, []);
});

test('duplicate and unsafe chunks are remapped before citation display', () => {
    const result = readGoogleSearchGrounding(
        candidate({
            groundingChunks: [
                { web: { uri: 'https://127.0.0.1/job' } },
                { web: { uri: source, title: 'Valid source' } },
                { web: { uri: source, title: 'Duplicate source' } },
            ],
            groundingSupports: [
                {
                    segment: { endIndex: Buffer.byteLength(text), text },
                    groundingChunkIndices: [0, 1, 2, 999, 1, '1'],
                },
            ],
        }),
    );
    assert.deepEqual(result?.sources, [{ url: source, title: 'Valid source' }]);
    assert.deepEqual(result?.citations, [
        { startIndex: 0, endIndex: text.length, sourceIndexes: [0] },
    ]);
});

test('attribution bounds limit sources, queries, suggestions and citations', () => {
    const result = readGoogleSearchGrounding(
        candidate({
            groundingChunks: Array.from({ length: 100 }, (_, index) => ({
                web: { uri: `${source}?id=${index}`, title: 'A'.repeat(301) },
            })),
            webSearchQueries: Array.from(
                { length: 30 },
                (_, index) => `query ${index}`,
            ),
            groundingSupports: Array.from({ length: 150 }, () => ({
                segment: { endIndex: Buffer.byteLength(text), text },
                groundingChunkIndices: Array.from(
                    { length: 100 },
                    (_, index) => index,
                ),
            })),
            searchEntryPoint: {
                sdkBlob: Buffer.from(
                    JSON.stringify(
                        Array.from({ length: 30 }, (_, index) => [
                            `Query ${index}`,
                            `https://www.google.com/search?q=${index}`,
                        ]),
                    ),
                ).toString('base64'),
            },
        }),
    );
    assert.equal(result?.sources.length, 12);
    assert.equal(result?.searchQueries.length, 12);
    assert.equal(result?.searchSuggestions.length, 5);
    assert.equal(result?.citations.length, 100);
    assert.equal(result?.citations[0]?.sourceIndexes.length, 12);
    assert.equal(result?.sources[0]?.title, 'jobs.nhs.uk');
});

test('original widget suggestions become text and original Google links, never executable HTML', () => {
    const result = readGoogleSearchGrounding(
        candidate({
            searchEntryPoint: {
                renderedContent: `<style>body{display:none}</style><a href="https://www.google.com/search?q=NHS&amp;hl=en"><span>NHS &amp; London</span></a><a href="javascript:alert(1)">bad</a><a href="https://google.com.evil.co.uk/search?q=bad">bad host</a><a href="https://sites.google.com/search?q=bad">bad host</a><a href="https://www.google.com/url?q=https://evil.co.uk">redirect</a>`,
            },
        }),
    );
    assert.deepEqual(result?.searchSuggestions, [
        {
            label: 'NHS & London',
            url: 'https://www.google.com/search?q=NHS&hl=en',
        },
    ]);
    assert.equal(JSON.stringify(result).includes('<style>'), false);
});

test('SDK suggestion tuples must be original safe Google search links', () => {
    const result = readGoogleSearchGrounding(
        candidate({
            searchEntryPoint: {
                sdkBlob: Buffer.from(
                    JSON.stringify([
                        ['valid', 'https://www.google.co.uk/search?q=jobs'],
                        ['another', 'https://www.google.ie/search?q=jobs'],
                        ['unsafe', 'https://example.org/search?q=jobs'],
                        ['local', 'http://www.google.com/search?q=jobs'],
                        [
                            'long'.repeat(100),
                            'https://www.google.com/search?q=long',
                        ],
                        [
                            'extra',
                            'https://www.google.com/search?q=extra',
                            'untrusted',
                        ],
                    ]),
                ).toString('base64'),
            },
        }),
    );
    assert.deepEqual(result?.searchSuggestions, [
        { label: 'valid', url: 'https://www.google.co.uk/search?q=jobs' },
        { label: 'another', url: 'https://www.google.ie/search?q=jobs' },
    ]);
});

test('current native Google widget redirects remain original display-only suggestion links', () => {
    const redirect =
        'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-provider-token';
    const result = readGoogleSearchGrounding(
        candidate({
            searchEntryPoint: {
                renderedContent:
                    `<a class="chip" href="${redirect}">Original Google query label</a>` +
                    '<a href="https://vertexaisearch.cloud.google.com/other/opaque">Wrong path</a>' +
                    '<a href="https://vertexaisearch.cloud.google.com/grounding-api-redirect/">Missing token</a>' +
                    '<a href="https://vertexaisearch.cloud.google.com.evil.co.uk/grounding-api-redirect/opaque">Wrong host</a>' +
                    '<a href="https://evil.vertexaisearch.cloud.google.com/grounding-api-redirect/opaque">Wrong subdomain</a>',
            },
        }),
    );
    assert.deepEqual(result?.searchSuggestions, [
        { label: 'Original Google query label', url: redirect },
    ]);
});

test('UTF-8 citation bytes are converted to JS offsets including multipart prefixes', () => {
    const first = 'Café 🧑🏽‍🎓 ';
    const second = '£40,000 in London';
    const raw = candidate();
    raw.content = {
        parts: [
            { text: 'private thoughts', thought: true },
            { text: first },
            { text: second },
        ],
    };
    raw.groundingMetadata = {
        ...(raw.groundingMetadata as Record<string, unknown>),
        groundingSupports: [
            {
                segment: {
                    partIndex: 2,
                    startIndex: 0,
                    endIndex: Buffer.byteLength('£40,000'),
                    text: '£40,000',
                },
                groundingChunkIndices: [0],
            },
        ],
    };
    assert.deepEqual(readGoogleSearchGrounding(raw)?.citations, [
        {
            startIndex: first.length,
            endIndex: first.length + '£40,000'.length,
            sourceIndexes: [0],
        },
    ]);
});

test('invalid citation boundaries, forged text and unknown parts cannot acquire source badges', () => {
    const raw = candidate();
    raw.content = { parts: [{ text: '£40,000' }] };
    raw.groundingMetadata = {
        ...(raw.groundingMetadata as Record<string, unknown>),
        groundingSupports: [
            {
                segment: { startIndex: 1, endIndex: 3 },
                groundingChunkIndices: [0],
            },
            {
                segment: { startIndex: 0, endIndex: 1 },
                groundingChunkIndices: [0],
            },
            {
                segment: { startIndex: 0, endIndex: 3, text: 'forged' },
                groundingChunkIndices: [0],
            },
            {
                segment: { startIndex: -1, endIndex: 3 },
                groundingChunkIndices: [0],
            },
            {
                segment: { partIndex: 50, endIndex: 3 },
                groundingChunkIndices: [0],
            },
            { segment: { endIndex: 99999 }, groundingChunkIndices: [0] },
        ],
    };
    assert.deepEqual(readGoogleSearchGrounding(raw)?.citations, []);
});

test('a source badge requires the exact provider segment text, not just plausible byte offsets', () => {
    const result = readGoogleSearchGrounding(
        candidate({
            groundingSupports: [
                {
                    segment: {
                        startIndex: 0,
                        endIndex: Buffer.byteLength(text),
                    },
                    groundingChunkIndices: [0],
                },
            ],
        }),
    );
    assert.deepEqual(result?.citations, []);
});

test('live research uses structured active criteria and preserves original provider text', async () => {
    let calls = 0;
    let usage = 0;
    const result = await searchChatGoogleWeb(search, 'uk', {
        now: () => Date.parse('2026-10-27T20:00:00Z'),
        generate: async (operation, request) => {
            calls++;
            assert.equal(operation, 'jobs_web_discovery');
            const payload = request.contents as Array<{
                parts: Array<{ text: string }>;
            }>;
            const input = JSON.parse(payload[0]!.parts[0]!.text);
            assert.equal(input.country, 'United Kingdom');
            assert.equal(input.date, '2026-10-27');
            assert.equal(input.criteria.role, 'data analyst');
            assert.equal(input.criteria.location, 'London');
            assert.equal(input.criteria.employer, 'NHS');
            assert.equal('history' in input, false);
            assert.equal('profile' in input, false);
            return success();
        },
        onGeneration: () => {
            usage++;
        },
    });
    assert.equal(calls, 2);
    assert.equal(usage, 2);
    assert.equal(result.text, text);
    assert.deepEqual(result.sources, grounding().sources);
    assert.equal(result.retrievedAt, '2026-10-27T20:00:00.000Z');
    assert.equal('jobs' in result, false);
    assert.equal('totalCount' in result, false);
});

test('CV matching may add only bounded alternative titles and an anonymous background; manual chat adds none', async () => {
    const inputs: Array<{ criteria: Record<string, unknown>; candidateBackground?: unknown }> = [];
    const prompts: string[] = [];
    const generate: NonNullable<Parameters<typeof searchChatGoogleWeb>[2]>['generate'] = async (_operation, request) => {
        const payload = request.contents as Array<{ parts: Array<{ text: string }> }>;
        inputs.push(JSON.parse(payload[0]!.parts[0]!.text));
        prompts.push(payload.map((item) => item.parts.map((part) => part.text).join(' ')).join(' '));
        return success();
    };
    await searchChatGoogleWeb(search, 'uk', { now: () => Date.parse('2026-10-27T20:00:00Z'), generate, searchContext: {
        alternativeTitles: ['Data Analyst', 'Reporting Analyst', 'x'.repeat(81), 'Insight Analyst', 'BI Analyst', 'MI Analyst',
            'Data Officer', 'Analytics Assistant', 'Eighth Title'],
        level: 'early-career', skills: ['Python', 'SQL', 'Excel', 'Tableau', 'Power BI', 'Sixth Skill'],
    } });
    assert.deepEqual(inputs[0]!.criteria.alternativeTitles,
        ['Reporting Analyst', 'Insight Analyst', 'BI Analyst', 'MI Analyst', 'Data Officer']);
    assert.deepEqual(inputs[0]!.candidateBackground,
        { careerStage: 'early-career', skills: ['Python', 'SQL', 'Excel', 'Tableau', 'Power BI'] });
    assert.match(prompts[0]!, /Any of the alternative titles is an acceptable vacancy title/);
    assert.match(prompts[0]!, /anonymous candidate background/);
    inputs.length = 0; prompts.length = 0;
    await searchChatGoogleWeb(search, 'uk', { now: () => Date.parse('2026-10-27T20:00:00Z'), generate });
    assert.equal('alternativeTitles' in inputs[0]!.criteria, false);
    assert.equal('candidateBackground' in inputs[0]!, false);
    assert.doesNotMatch(prompts[0]!, /alternative titles|candidate background/);
});

test('research never caches a preceding provider response', async () => {
    let calls = 0;
    const deps = {
        generate: async () => {
            calls++;
            return success();
        },
    };
    await searchChatGoogleWeb(search, 'uk', deps);
    await searchChatGoogleWeb(search, 'uk', deps);
    assert.equal(calls, 4);
});

test('unsupported search constraints do not trigger a silently broader web request', async () => {
    let calls = 0;
    const deps = {
        generate: async () => {
            calls++;
            return success();
        },
    };
    await assert.rejects(
        searchChatGoogleWeb(
            { ...search, unsupported: ['commute distance'] },
            'uk',
            deps,
        ),
        (error: unknown) =>
            error instanceof ChatGoogleWebError && error.code === 'UNSUPPORTED',
    );
    await assert.rejects(
        searchChatGoogleWeb({ ...search, kind: 'part-time' }, 'ireland', deps),
        ChatGoogleWebError,
    );
    assert.equal(calls, 0);
});

test('generated URLs alone, ungrounded fallbacks and incomplete research fail closed', async () => {
    const cases = [
        success({ groundingMetadata: undefined }),
        success({ provider: 'openai' }),
        success({ diagnostics: { finishReason: 'MAX_TOKENS' } }),
        success({ diagnostics: undefined }),
        success({
            body: {
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'https://jobs.nhs.uk/invented' }],
                        },
                    },
                ],
            },
            groundingMetadata: undefined,
        }),
        ...(
            [
                'sources',
                'citations',
                'searchQueries',
                'searchSuggestions',
            ] as const
        ).map((field) =>
            success({ groundingMetadata: { ...grounding(), [field]: [] } }),
        ),
    ];
    for (const value of cases) {
        await assert.rejects(
            searchChatGoogleWeb(search, 'uk', { generate: async () => value }),
            (error: unknown) =>
                error instanceof ChatGoogleWebError &&
                error.code === 'UNGROUNDED',
        );
    }
});

test('provider and usage-store failures never expose search text or raw provider errors', async () => {
    await assert.rejects(
        searchChatGoogleWeb(search, 'uk', {
            generate: async () => {
                throw new Error('private provider payload');
            },
        }),
        (error: unknown) =>
            error instanceof ChatGoogleWebError &&
            !error.message.includes('private'),
    );
    await assert.rejects(
        searchChatGoogleWeb(search, 'uk', {
            generate: async () => ({
                ok: false,
                status: 429,
                errorText: 'private rate-limit payload',
            }),
        }),
        ChatGoogleWebError,
    );
    const result = await searchChatGoogleWeb(search, 'uk', {
        generate: async () => success(),
        onGeneration: () => {
            throw new Error('private usage-store payload');
        },
    });
    assert.equal(result.text, text);
});

test('Gemini transport preserves only its real native grounding envelope', async (context) => {
    await withEnvironment(
        { GEMINI_API_KEY: 'fake-offline-test-key' },
        async () => {
            context.mock.method(
                globalThis,
                'fetch',
                async (url: unknown, options: RequestInit) => {
                    assert.equal(new URL(String(url)).search, '');
                    assert.equal(
                        new Headers(options.headers).get('x-goog-api-key'),
                        'fake-offline-test-key',
                    );
                    assert.deepEqual(JSON.parse(String(options.body)).tools, [{ urlContext: {} }]);
                    return new Response(
                        JSON.stringify({
                            candidates: [
                                { ...candidate(), finishReason: 'STOP' },
                            ],
                            usageMetadata: {
                                promptTokenCount: 100,
                                candidatesTokenCount: 30,
                            },
                        }),
                        { status: 200 },
                    );
                },
            );
            const result = await callGemini(
                'jobs_web_discovery',
                { contents: [], systemInstruction: {} },
                'gemini-3.5-flash-lite',
            );
            assert.equal(result.ok, true);
            if (result.ok) {
                assert.deepEqual(result.groundingMetadata, grounding());
                assert.deepEqual(result.urlContextMetadata, {
                    retrievals: [{ url: source, status: 'success' }],
                });
                assert.equal(result.promptTokens, 100);
            }
        },
    );
});

test('orchestrator never uses an ungrounded OpenAI fallback for web research', async (context) => {
    await withEnvironment(
        {
            GEMINI_API_KEY: 'fake-offline-test-key',
            OPENAI_API_KEY: 'fake-offline-openai-key',
            AI_PRIMARY_MAX_ATTEMPTS: '1',
            AI_GEMINI_FALLBACK_MAX_ATTEMPTS: '1',
            AI_RETRY_BACKOFF_MS: '0',
            BETA_MODE: 'true',
        },
        async () => {
            const hosts: string[] = [];
            context.mock.method(globalThis, 'fetch', async (url: unknown) => {
                hosts.push(new URL(String(url)).hostname);
                return new Response('unavailable', { status: 503 });
            });
            const result = await executeAiGeneration(
                'jobs_web_discovery',
                { contents: [], systemInstruction: {} },
                { primaryModel: 'gpt-4o-mini' },
            );
            assert.equal(result.ok, false);
            assert.deepEqual(hosts, ['generativelanguage.googleapis.com']);
        },
    );
});

test('orchestrator preserves native metadata beside the Gemini-shaped text response', async (context) => {
    await withEnvironment(
        { GEMINI_API_KEY: 'fake-offline-test-key' },
        async () => {
            context.mock.method(
                globalThis,
                'fetch',
                async () =>
                    new Response(
                        JSON.stringify({
                            candidates: [
                                { ...candidate(), finishReason: 'STOP' },
                            ],
                            usageMetadata: {
                                promptTokenCount: 100,
                                candidatesTokenCount: 30,
                            },
                        }),
                        { status: 200 },
                    ),
            );
            const result = await executeAiGeneration('jobs_web_discovery', {
                contents: [],
                systemInstruction: {},
            });
            assert.equal(result.ok, true);
            if (result.ok) {
                assert.deepEqual(result.groundingMetadata, grounding());
                assert.deepEqual(result.urlContextMetadata, {
                    retrievals: [{ url: source, status: 'success' }],
                });
                assert.deepEqual(result.body, {
                    candidates: [{ content: { parts: [{ text }] } }],
                });
                assert.equal(result.diagnostics?.finishReason, 'STOP');
                assert.equal(result.diagnostics?.promptTokens, 100);
            }
        },
    );
});

test('empty provider content retains only bounded native finish/count diagnostics', async (context) => {
    await withEnvironment(
        { GEMINI_API_KEY: 'fake-offline-test-key' },
        async () => {
            context.mock.method(
                globalThis,
                'fetch',
                async () =>
                    new Response(
                        JSON.stringify({
                            candidates: [
                                {
                                    finishReason: 'MAX_TOKENS',
                                    content: {
                                        parts: [
                                            {
                                                thought: true,
                                                text: 'private generated thought',
                                            },
                                            {
                                                functionCall: {
                                                    name: 'privateTool',
                                                    args: {
                                                        url: 'https://private.example/secret',
                                                    },
                                                },
                                            },
                                        ],
                                    },
                                },
                            ],
                            usageMetadata: {
                                promptTokenCount: 100,
                                candidatesTokenCount: { private: 'secret' },
                                thoughtsTokenCount: -1,
                            },
                        }),
                        { status: 200 },
                    ),
            );
            const result = await executeAiGeneration(
                'jobs_web_discovery',
                { contents: [], systemInstruction: {} },
                { maxTotalAttempts: 1 },
            );
            assert.equal(result.ok, false);
            if (!result.ok) {
                assert.equal(result.status, 502);
                assert.deepEqual(result.diagnostics, {
                    finishReason: 'MAX_TOKENS',
                    promptTokens: 100,
                    outputTokens: undefined,
                    thoughtsTokens: undefined,
                    contentParts: 2,
                    textParts: 0,
                    thoughtParts: 1,
                    functionCallParts: 1,
                });
                assert.equal(JSON.stringify(result).includes('private'), false);
            }
        },
    );
});

test('provider diagnostics reject content-shaped finish reasons and unbounded token counts', async (context) => {
    await withEnvironment(
        { GEMINI_API_KEY: 'fake-offline-test-key' },
        async () => {
            context.mock.method(
                globalThis,
                'fetch',
                async () =>
                    new Response(
                        JSON.stringify({
                            candidates: [
                                {
                                    finishReason: 'private prompt text',
                                    content: { parts: [] },
                                },
                            ],
                            usageMetadata: {
                                promptTokenCount: 1_000_000_001,
                                candidatesTokenCount: 1.5,
                                thoughtsTokenCount: 'private',
                            },
                        }),
                        { status: 200 },
                    ),
            );
            const result = await callGemini(
                'jobs_web_discovery',
                { contents: [], systemInstruction: {} },
                'gemini-3.5-flash-lite',
            );
            assert.equal(result.ok, false);
            if (!result.ok) {
                assert.deepEqual(result.diagnostics, {
                    finishReason: undefined,
                    promptTokens: undefined,
                    outputTokens: undefined,
                    thoughtsTokens: undefined,
                    contentParts: 0,
                    textParts: 0,
                    thoughtParts: 0,
                    functionCallParts: 0,
                });
                assert.equal(JSON.stringify(result).includes('private'), false);
            }
        },
    );
});

test('web research forwards cancellation/deadline options and defaults to one physical provider call', async () => {
    const controller = new AbortController();
    const result = await searchChatGoogleWeb(search, 'uk', {
        signal: controller.signal,
        timeoutMs: 750,
        generate: async (_operation, _request, options) => {
            assert.ok(options?.signal instanceof AbortSignal);
            assert.ok(options?.timeoutMs! > 0 && options?.timeoutMs! <= 750);
            assert.equal(options?.maxTotalAttempts, 1);
            return success();
        },
        validateAnswer: (answer) => answer === text,
    });
    assert.equal(result.text, text);
});

test('out-of-scope or injected research responses cannot bypass the caller answer policy', async () => {
    for (const validateAnswer of [
        () => false,
        () => {
            throw new Error('private policy detail');
        },
    ]) {
        await assert.rejects(
            searchChatGoogleWeb(search, 'uk', {
                generate: async () => success(),
                validateAnswer,
            }),
            (error: unknown) =>
                error instanceof ChatGoogleWebError &&
                error.code === 'UNGROUNDED',
        );
    }
});

test('an already cancelled web request makes no provider call', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
        searchChatGoogleWeb(search, 'uk', {
            signal: controller.signal,
            generate: async () => {
                calls++;
                return success();
            },
        }),
        ChatGoogleWebError,
    );
    assert.equal(calls, 0);
});

test('an orchestration deadline aborts a stalled provider even when fetch ignores its signal', async (context) => {
    await withEnvironment(
        { GEMINI_API_KEY: 'fake-offline-test-key' },
        async () => {
            let calls = 0;
            let providerSignal: AbortSignal | undefined;
            context.mock.method(
                globalThis,
                'fetch',
                async (_url: unknown, options: RequestInit) => {
                    calls++;
                    providerSignal = options.signal ?? undefined;
                    return new Promise<Response>(() => {});
                },
            );
            const startedAt = Date.now();
            const result = await executeAiGeneration(
                'jobs_web_discovery',
                { contents: [], systemInstruction: {} },
                {
                    timeoutMs: 20,
                    maxTotalAttempts: 1,
                },
            );
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.status, 504);
            assert.equal(calls, 1);
            assert.equal(providerSignal?.aborted, true);
            assert.ok(Date.now() - startedAt < 1000);
        },
    );
});

test('caller cancellation aborts a running provider and removes its parent listener', async (context) => {
    await withEnvironment(
        { GEMINI_API_KEY: 'fake-offline-test-key' },
        async () => {
            const controller = new AbortController();
            let providerSignal: AbortSignal | undefined;
            context.mock.method(
                globalThis,
                'fetch',
                async (_url: unknown, options: RequestInit) => {
                    providerSignal = options.signal ?? undefined;
                    return new Promise<Response>(() => {});
                },
            );
            const pending = executeAiGeneration(
                'jobs_web_discovery',
                { contents: [], systemInstruction: {} },
                {
                    signal: controller.signal,
                    timeoutMs: 1000,
                    maxTotalAttempts: 1,
                },
            );
            controller.abort();
            const result = await pending;
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.status, 499);
            assert.equal(providerSignal?.aborted, true);
            assert.equal(
                getEventListeners(controller.signal, 'abort').length,
                0,
            );
        },
    );
});

test('an expired or already cancelled orchestration budget never starts fetch', async (context) => {
    await withEnvironment(
        { GEMINI_API_KEY: 'fake-offline-test-key' },
        async () => {
            let calls = 0;
            context.mock.method(globalThis, 'fetch', async () => {
                calls++;
                return new Response('{}');
            });
            const controller = new AbortController();
            controller.abort();
            for (const options of [
                { timeoutMs: 0 },
                { signal: controller.signal },
            ]) {
                const result = await executeAiGeneration(
                    'jobs_web_discovery',
                    { contents: [], systemInstruction: {} },
                    options,
                );
                assert.equal(result.ok, false);
            }
            assert.equal(calls, 0);
        },
    );
});

test('physical attempt limits include retries and all fallback models', async (context) => {
    await withEnvironment(
        {
            GEMINI_API_KEY: 'fake-offline-test-key',
            OPENAI_API_KEY: 'fake-offline-openai-key',
            AI_PRIMARY_MAX_ATTEMPTS: '999',
            AI_GEMINI_FALLBACK_MAX_ATTEMPTS: '999',
            AI_RETRY_BACKOFF_MS: '0',
        },
        async () => {
            let calls = 0;
            context.mock.method(globalThis, 'fetch', async () => {
                calls++;
                return new Response('unavailable', { status: 503 });
            });
            const result = await executeAiGeneration(
                'jobs_search_chat',
                { contents: [], systemInstruction: {} },
                {
                    maxTotalAttempts: 1,
                    timeoutMs: 1000,
                },
            );
            assert.equal(result.ok, false);
            assert.equal(calls, 1);
        },
    );
});

test('retry backoff cannot outlive the overall request deadline', async (context) => {
    await withEnvironment(
        {
            GEMINI_API_KEY: 'fake-offline-test-key',
            AI_PRIMARY_MAX_ATTEMPTS: '2',
            AI_RETRY_BACKOFF_MS: '8000',
        },
        async () => {
            let calls = 0;
            context.mock.method(globalThis, 'fetch', async () => {
                calls++;
                return new Response('unavailable', { status: 503 });
            });
            const startedAt = Date.now();
            const result = await executeAiGeneration(
                'jobs_web_discovery',
                { contents: [], systemInstruction: {} },
                {
                    timeoutMs: 20,
                    maxTotalAttempts: 2,
                },
            );
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.status, 504);
            assert.equal(calls, 1);
            assert.ok(Date.now() - startedAt < 1000);
        },
    );
});

test('successful orchestration releases the caller abort listener and deadline timer', async (context) => {
    await withEnvironment(
        { GEMINI_API_KEY: 'fake-offline-test-key' },
        async () => {
            const controller = new AbortController();
            context.mock.method(
                globalThis,
                'fetch',
                async () =>
                    new Response(
                        JSON.stringify({
                            candidates: [
                                { ...candidate(), finishReason: 'STOP' },
                            ],
                        }),
                        { status: 200 },
                    ),
            );
            const result = await executeAiGeneration(
                'jobs_web_discovery',
                { contents: [], systemInstruction: {} },
                {
                    signal: controller.signal,
                    timeoutMs: 1000,
                    maxTotalAttempts: 1,
                },
            );
            assert.equal(result.ok, true);
            assert.equal(
                getEventListeners(controller.signal, 'abort').length,
                0,
            );
        },
    );
});

test('a token citation cannot make a largely uncited research answer acceptable', async () => {
    const answer = `A cited introduction.\n\n${'Unsupported claim content '.repeat(30)}`;
    const metadata = {
        ...grounding(),
        citations: [
            {
                startIndex: 0,
                endIndex: 'A cited introduction.'.length,
                sourceIndexes: [0],
            },
        ],
    };
    assert.equal(hasSufficientChatCitationCoverage(answer, metadata), false);
    await assert.rejects(
        searchChatGoogleWeb(search, 'uk', {
            generate: async () =>
                success({
                    body: {
                        candidates: [
                            { content: { parts: [{ text: answer }] } },
                        ],
                    },
                    groundingMetadata: metadata,
                }),
        }),
        (error: unknown) =>
            error instanceof ChatGoogleWebError && error.code === 'UNGROUNDED',
    );
});

test('native spans covering the complete answer pass without modifying the original text', async () => {
    const answer = text;
    const metadata = {
        ...grounding(),
        citations: [
            { startIndex: 0, endIndex: answer.length, sourceIndexes: [0] },
        ],
    };
    assert.equal(hasSufficientChatCitationCoverage(answer, metadata), true);
    const result = await searchChatGoogleWeb(search, 'uk', {
        generate: async () =>
            success({
                body: {
                    candidates: [{ content: { parts: [{ text: answer }] } }],
                },
                groundingMetadata: metadata,
            }),
    });
    assert.equal(result.text, answer);
});

test('adjacent and overlapping citation spans use their union rather than inflated repeated lengths', () => {
    const answer = 'A'.repeat(100);
    const check = (ranges: Array<[number, number]>) =>
        hasSufficientChatCitationCoverage(answer, {
            ...grounding(),
            citations: ranges.map(([startIndex, endIndex]) => ({
                startIndex,
                endIndex,
                sourceIndexes: [0],
            })),
        });
    assert.equal(
        check([
            [0, 30],
            [30, 60],
        ]),
        true,
    );
    assert.equal(
        check([
            [0, 40],
            [20, 60],
        ]),
        true,
    );
    assert.equal(
        check([
            [0, 40],
            [0, 40],
            [5, 35],
        ]),
        false,
    );
    assert.equal(check([[0, 59]]), false);
});

test('a short uncited introduction is allowed when the following native attribution is strong', () => {
    const intro = 'Recent source information needs checking.\n\n';
    const body =
        'The cited source describes an advertised role and its application steps. '.repeat(
            6,
        );
    assert.equal(
        hasSufficientChatCitationCoverage(intro + body, {
            ...grounding(),
            citations: [
                {
                    startIndex: intro.length,
                    endIndex: intro.length + body.length,
                    sourceIndexes: [0],
                },
            ],
        }),
        true,
    );
});

test('a long uncited paragraph is rejected even when other paragraphs make overall coverage high', () => {
    const first = 'Unattributed assertions '.repeat(20);
    const second = 'Source attributed information '.repeat(100);
    const answer = first + '\n\n' + second;
    assert.equal(
        hasSufficientChatCitationCoverage(answer, {
            ...grounding(),
            citations: [
                { startIndex: 0, endIndex: 4, sourceIndexes: [0] },
                {
                    startIndex: first.length + 2,
                    endIndex: answer.length,
                    sourceIndexes: [0],
                },
            ],
        }),
        false,
    );
});

test('coverage counts Unicode letters and numbers without punctuation or emoji inflation', () => {
    const cited = '£40,000 Café 数据 ';
    const answer = cited + '--- 🧑🏽‍🎓 --- ' + 'ABC';
    assert.equal(
        hasSufficientChatCitationCoverage(answer, {
            ...grounding(),
            citations: [
                { startIndex: 0, endIndex: cited.length, sourceIndexes: [0] },
            ],
        }),
        true,
    );
    assert.equal(
        hasSufficientChatCitationCoverage('--- 🧑🏽‍🎓 ---', {
            ...grounding(),
            citations: [
                {
                    startIndex: 0,
                    endIndex: '--- 🧑🏽‍🎓 ---'.length,
                    sourceIndexes: [0],
                },
            ],
        }),
        false,
    );
});

test('invalid native spans cannot manufacture attribution coverage', () => {
    for (const citation of [
        { startIndex: -1, endIndex: text.length, sourceIndexes: [0] },
        { startIndex: 0, endIndex: text.length + 1, sourceIndexes: [0] },
        { startIndex: 0, endIndex: text.length, sourceIndexes: [99] },
        { startIndex: 0, endIndex: text.length, sourceIndexes: [] },
        { startIndex: 0.5, endIndex: text.length, sourceIndexes: [0] },
    ])
        assert.equal(
            hasSufficientChatCitationCoverage(text, {
                ...grounding(),
                citations: [citation],
            }),
            false,
        );
    assert.equal(
        hasSufficientChatCitationCoverage('🧑ABCD', {
            ...grounding(),
            citations: [{ startIndex: 1, endIndex: 6, sourceIndexes: [0] }],
        }),
        false,
    );
});

function cardBatch(
    cards: Array<typeof originalCard | Record<string, unknown>> = [
        originalCard,
    ],
) {
    const answer = JSON.stringify({ cards });
    let cursor = 0;
    const citations = cards.map((card, index) => {
        const raw = JSON.stringify(card);
        const startIndex = answer.indexOf(raw, cursor);
        cursor = startIndex + raw.length;
        return { startIndex, endIndex: cursor, sourceIndexes: [index] };
    });
    const metadata: GoogleSearchGrounding = {
        ...grounding(),
        sources: cards.map((card) => ({
            url: String(card.url),
            title: String(card.title),
        })),
        citations,
    };
    const context = {
        retrievals: cards.map((card) => ({
            url: String(card.url),
            status: 'success' as const,
        })),
    };
    return { answer, metadata, context };
}

test('original Google cards retain every value/order and derive source indexes from native card spans', () => {
    const second = {
        ...originalCard,
        title: 'Senior Data Analyst',
        url: `${source}?job=second`,
        description:
            'The advert describes "data quality" work in Café reporting, with source evidence.',
    };
    const batch = cardBatch([originalCard, second]);
    const cards = parseOriginalGoogleJobCards(
        batch.answer,
        batch.metadata,
        batch.context,
        '2026-10-27',
    );
    assert.deepEqual(cards, [
        { ...originalCard, sourceIndexes: [0] },
        { ...second, sourceIndexes: [1] },
    ]);
    assert.equal(
        batch.answer,
        JSON.stringify({ cards: [originalCard, second] }),
    );
});

test('native URL context accepts only bounded real provider retrieval pairs', () => {
    assert.deepEqual(readGoogleUrlContextMetadata(candidate()), {
        retrievals: [{ url: source, status: 'success' }],
    });
    assert.deepEqual(
        readGoogleUrlContextMetadata({
            url_context_metadata: {
                url_metadata: [
                    {
                        retrieved_url: source,
                        url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS',
                    },
                    {
                        retrieved_url: `${source}?failed`,
                        url_retrieval_status: 'URL_RETRIEVAL_STATUS_ERROR',
                    },
                    {
                        retrieved_url: 'https://127.0.0.1/private',
                        url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS',
                    },
                    {
                        retrieved_url: source,
                        url_retrieval_status: 'MODEL_SAID_SUCCESS',
                    },
                ],
            },
        }),
        {
            retrievals: [
                { url: source, status: 'success' },
                { url: `${source}?failed`, status: 'error' },
            ],
        },
    );
    const large = readGoogleUrlContextMetadata({
        urlContextMetadata: {
            urlMetadata: Array.from({ length: 100 }, (_, index) => ({
                retrievedUrl: `${source}?item=${index}`,
                urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS',
            })),
        },
    });
    assert.equal(large?.retrievals.length, 20);
});

test('a model-generated advert URL is rejected without exact successful native URL retrieval', () => {
    const batch = cardBatch();
    for (const context of [
        undefined,
        { retrievals: [] },
        {
            retrievals: [
                { url: `${source}?different`, status: 'success' as const },
            ],
        },
        { retrievals: [{ url: source, status: 'error' as const }] },
        { retrievals: [{ url: source, status: 'paywall' as const }] },
        { retrievals: [{ url: source, status: 'unsafe' as const }] },
        {
            retrievals: [
                { url: source, status: 'success' as const },
                { url: source, status: 'error' as const },
            ],
        },
    ])
        assert.throws(
            () =>
                parseOriginalGoogleJobCards(
                    batch.answer,
                    batch.metadata,
                    context,
                    '2026-10-27',
                ),
            ChatGoogleWebError,
        );
});

test('expiry is evaluated against the requested day and rejects the entire original batch', () => {
    const expired = {
        ...originalCard,
        title: 'Another Data Analyst',
        url: `${source}?expired`,
        closingDate: '2026-10-26',
    };
    const batch = cardBatch([originalCard, expired]);
    assert.throws(
        () =>
            parseOriginalGoogleJobCards(
                batch.answer,
                batch.metadata,
                batch.context,
                '2026-10-27',
            ),
        ChatGoogleWebError,
    );
    const today = cardBatch([{ ...originalCard, closingDate: '2026-10-27' }]);
    assert.equal(
        parseOriginalGoogleJobCards(
            today.answer,
            today.metadata,
            today.context,
            '2026-10-27',
        ).length,
        1,
    );
});

test('the server enforces the two-advert limit without relying on provider JSON constraints', () => {
    const batch = cardBatch(Array.from({ length: 3 }, (_, index) => ({
        ...originalCard,
        url: `${source}?advert=${index}`,
    })));
    assert.throws(
        () => parseOriginalGoogleJobCards(batch.answer, batch.metadata, batch.context, '2026-10-27'),
        ChatGoogleWebError,
    );
});

test('future posting dates, impossible dates and conflicting deadlines reject Google cards', () => {
    for (const values of [
        { postedDate: '2026-10-28' },
        { closingDate: '2026-02-30' },
        { postedDate: '2026-10-25', closingDate: '2026-10-24' },
        { closingDate: 'tomorrow' },
        { postedDate: '2026-13-01' },
    ]) {
        const batch = cardBatch([{ ...originalCard, ...values }]);
        assert.throws(
            () =>
                parseOriginalGoogleJobCards(
                    batch.answer,
                    batch.metadata,
                    batch.context,
                    '2026-10-27',
                ),
            ChatGoogleWebError,
        );
    }
});

test('unknown source details remain null and do not manufacture posting or closing dates', () => {
    const unknown = { ...originalCard, closingDate: null, postedDate: null };
    const batch = cardBatch([unknown]);
    const [card] = parseOriginalGoogleJobCards(
        batch.answer,
        batch.metadata,
        batch.context,
        '2026-10-27',
    );
    assert.equal(card?.closingDate, null);
    assert.equal(card?.postedDate, null);
    assert.equal(card?.salary, null);
    assert.equal(card?.workingArrangement, null);
});

test('general careers/search pages and Google result redirects cannot become application links', () => {
    for (const url of [
        'https://jobs.nhs.uk/',
        'https://jobs.nhs.uk/candidate/search',
        'https://acme.co.uk/careers',
        'https://acme.co.uk/careers/jobs',
        'https://acme.co.uk/jobs/search?query=analyst',
        'https://www.civilservicejobs.service.gov.uk/csr/index.cgi?SID=search',
        'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?query=software',
        'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque',
        'https://www.google.com/search?q=analyst',
        'http://acme.co.uk/jobs/123',
        'https://user:password@acme.co.uk/jobs/123',
        'https://127.0.0.1/jobs/123',
    ])
        assert.equal(
            isIndividualGoogleJobUrl(url),
            false,
            'A general or unsafe URL must fail closed',
        );
    assert.equal(isIndividualGoogleJobUrl(source), true);
    assert.equal(
        isIndividualGoogleJobUrl(
            'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=1234567',
        ),
        true,
    );
    assert.equal(
        isIndividualGoogleJobUrl('https://boards.greenhouse.io/acme/jobs/123'),
        true,
    );
});

test('extra fields, duplicate keys/URLs, oversized fields and plain narrative fail strict card parsing', () => {
    for (const value of [
        { ...originalCard, sourceIndexes: [0] },
        { ...originalCard, description: 'x'.repeat(1201) },
        { ...originalCard, explanation: 'x'.repeat(501) },
        { ...originalCard, employer: '' },
        { ...originalCard, title: ' Leading whitespace' },
        { ...originalCard, title: '<b>Data Analyst</b>' },
    ]) {
        const batch = cardBatch([value]);
        assert.throws(
            () =>
                parseOriginalGoogleJobCards(
                    batch.answer,
                    batch.metadata,
                    batch.context,
                    '2026-10-27',
                ),
            ChatGoogleWebError,
        );
    }
    const duplicated = cardBatch([originalCard, originalCard]);
    assert.throws(
        () =>
            parseOriginalGoogleJobCards(
                duplicated.answer,
                duplicated.metadata,
                duplicated.context,
                '2026-10-27',
            ),
        ChatGoogleWebError,
    );
    const duplicateKey = text.replace(
        '"title":"Data Analyst"',
        '"title":"Data Analyst","title":"Different"',
    );
    assert.throws(
        () =>
            parseOriginalGoogleJobCards(
                duplicateKey,
                {
                    ...grounding(),
                    citations: [
                        {
                            startIndex: 0,
                            endIndex: duplicateKey.length,
                            sourceIndexes: [0],
                        },
                    ],
                },
                success().urlContextMetadata,
                '2026-10-27',
            ),
        ChatGoogleWebError,
    );
    assert.throws(
        () =>
            parseOriginalGoogleJobCards(
                'Here are some jobs.',
                grounding(),
                success().urlContextMetadata,
                '2026-10-27',
            ),
        ChatGoogleWebError,
    );
});

test('URL-retrieved cards accept sparse native citations on advert facts without inventing all-field coverage', () => {
    const batch = cardBatch();
    // Most of the JSON is attributed, but the actual title has no source support.
    const uncitedTitleEnd = batch.answer.indexOf('"employer"');
    batch.metadata.citations = [
        {
            startIndex: uncitedTitleEnd,
            endIndex: batch.answer.length,
            sourceIndexes: [0],
        },
    ];
    assert.equal(
        hasSufficientChatCitationCoverage(batch.answer, batch.metadata),
        true,
    );
    assert.equal(
            parseOriginalGoogleJobCards(
                batch.answer,
                batch.metadata,
                batch.context,
                '2026-10-27',
            ).length,
        1,
    );
});

test('URL Context provenance uses the exact retrieved advert source without fabricating field citations', () => {
    for (const field of ['explanation', 'url'] as const) {
        const batch = cardBatch();
        const startIndex = batch.answer.indexOf(JSON.stringify(originalCard[field]));
        batch.metadata.citations = [{ startIndex, endIndex: startIndex + JSON.stringify(originalCard[field]).length, sourceIndexes: [0] }];
        const cards = parseOriginalGoogleJobCards(batch.answer, batch.metadata, batch.context, '2026-10-27');
        assert.deepEqual(cards[0]!.sourceIndexes, [0]);
        assert.throws(() => parseOriginalGoogleJobCards(batch.answer, batch.metadata, undefined, '2026-10-27'), ChatGoogleWebError);
    }
});

test('an original Google advert wrapper requires the exact native source allowlist and successful retrieval', () => {
    const wrapped = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/native-source-123';
    const batch = cardBatch([{ ...originalCard, url: wrapped }]);
    assert.equal(isIndividualGoogleJobUrl(wrapped), false);
    assert.equal(isGoogleGroundingSourceUrl(wrapped), true);
    assert.equal(isGoogleGroundingSourceUrl('https://vertexaisearch.cloud.google.com.evil.co.uk/grounding-api-redirect/x'), false);
    assert.throws(() => parseOriginalGoogleJobCards(batch.answer, batch.metadata, batch.context, '2026-10-27'), ChatGoogleWebError);
    const cards = parseOriginalGoogleJobCards(batch.answer, batch.metadata, batch.context, '2026-10-27', [wrapped]);
    assert.equal(cards[0]!.url, wrapped);
    assert.throws(() => parseOriginalGoogleJobCards(batch.answer, batch.metadata, { retrievals: [] }, '2026-10-27', [wrapped]), ChatGoogleWebError);
});

test('search contains an explicit current-vacancy question while structured criteria remain separate untrusted data', async () => {
    let calls = 0;
    await searchChatGoogleWeb(search, 'uk', {
        generate: async (_operation, request) => {
            const contents = request.contents as Array<{ parts: Array<{ text: string }> }>;
            if (++calls === 1) {
                assert.equal(request.webDiscoveryPhase, 'search');
                assert.equal(JSON.parse(contents[0]!.parts[0]!.text).criteria.role, 'data analyst');
                assert.match(contents[0]!.parts[1]!.text, /Use Google Search now.*data analyst.*London.*United Kingdom/);
            } else {
                assert.equal(request.webDiscoveryPhase, 'extract');
            }
            return success();
        },
    });
    assert.equal(calls, 2);
});

test('native URL-only extraction keeps original Search citations separate from the extracted JSON', async () => {
    let calls = 0;
    const result = await searchChatGoogleWeb(search, 'uk', {
        generate: async () => ++calls === 1 ? success() : success({ groundingMetadata: undefined }),
    });
    assert.equal(result.cards!.length, 1);
    assert.deepEqual(result.retrievedUrls, [source]);
    assert.deepEqual(result.citations, []);
    assert.equal(result.searchResearch!.text, text);
    assert.deepEqual(result.searchResearch!.citations, grounding().citations);
    assert.equal(result.sources[result.cards![0]!.sourceIndexes[0]!]!.url, source);
});

test('extracted adverts cannot silently discard role, employer, location or institution filters', async () => {
    for (const fields of [
        { role: 'software engineer' }, { employer: 'Different Employer' },
        { where: 'Manchester' }, { employerScope: 'civil-service' as const },
        { workingArrangement: 'remote' as const }, { jobTypes: ['Full-time'] as const },
        { levels: ['Junior'] as const },
        { salary: { min: 40_000, currency: 'GBP' as const, period: 'year' as const } },
    ]) {
        let calls = 0;
        await assert.rejects(searchChatGoogleWeb(chatSearchSchema.parse({ ...search, ...fields }), 'uk', {
            generate: async () => { calls++; return success(); },
        }), ChatGoogleWebError);
        assert.equal(calls, 2);
    }
});

test('Google cannot establish a catalogue sponsor licence and skips unsupported sponsorship filters without spending', async () => {
    let calls = 0;
    for (const sponsorship of ['licensed-employer', 'advert-confirmed'] as const) {
        await assert.rejects(searchChatGoogleWeb({ ...search, sponsorship }, 'uk', {
            generate: async () => { calls++; return success(); },
        }), (error: unknown) => error instanceof ChatGoogleWebError && error.code === 'UNSUPPORTED');
    }
    assert.equal(calls, 0);
});

test('completed Google search can return zero cards without pretending a provider outage', async () => {
    const result = await searchChatGoogleWeb(search, 'uk', {
        generate: async () => success({
            body: { candidates: [{ content: { parts: [{ text: '{"cards":[]}' }] } }] },
            groundingMetadata: { ...grounding(), sources: [], citations: [], searchSuggestions: [] },
            urlContextMetadata: undefined,
        }),
    });
    assert.equal(result.format, 'job-cards');
    assert.deepEqual(result.cards, []);
    assert.equal(result.text, '{"cards":[]}');
});

test('structured answers concatenate ordered non-thought text parts without losing native offsets', async () => {
    const result = await searchChatGoogleWeb(search, 'uk', {
        generate: async () => success({
            body: { candidates: [{ content: { parts: [
                { thought: true, text: 'Untrusted hidden reasoning is not answer text.' },
                { text: text.slice(0, 40) }, { text: text.slice(40) },
            ] } }] },
        }),
    });
    assert.equal(result.text, text);
    assert.equal(result.cards?.length, 1);
});

test('explicitly closed vacancies or unsupported active/verified claims reject the whole original batch', () => {
    for (const claim of [
        'Applications are closed.',
        'This vacancy is expired.',
        'We are actively recruiting.',
        'The role is currently open.',
        'This listing is verified live.',
        'Guaranteed sponsorship is available.',
    ]) {
        const batch = cardBatch([{ ...originalCard, description: claim }]);
        assert.throws(
            () =>
                parseOriginalGoogleJobCards(
                    batch.answer,
                    batch.metadata,
                    batch.context,
                    '2026-10-27',
                ),
            ChatGoogleWebError,
        );
    }
});

test('search returns only ephemeral structured original Google cards with native retrieval/citation proof', async () => {
    const result = await searchChatGoogleWeb(search, 'uk', {
        now: () => Date.parse('2026-10-27T12:00:00Z'),
        generate: async () => success(),
    });
    assert.equal(result.format, 'job-cards');
    assert.deepEqual(result.cards, [{ ...originalCard, sourceIndexes: [0] }]);
    assert.equal(result.text, text);
    assert.equal('jobs' in result, false);
    assert.equal('urlContextMetadata' in result, false);
});

test('one explicit URL-context refinement can supply missing native proof without any application crawl', async (context) => {
    let calls = 0;
    let usage = 0;
    context.mock.method(globalThis, 'fetch', async () => {
        throw new Error('Application crawling is prohibited');
    });
    const result = await searchChatGoogleWeb(search, 'uk', {
        now: () => Date.parse('2026-10-27T12:00:00Z'),
        timeoutMs: 1000,
        maxTotalAttempts: 99,
        onGeneration: () => {
            usage++;
        },
        generate: async (_operation, request, options) => {
            calls++;
            assert.equal(options?.maxTotalAttempts, 1);
            const input = JSON.parse(
                (
                    request.contents as Array<{
                        parts: Array<{ text: string }>;
                    }>
                )[0]!.parts[0]!.text,
            );
            if (calls === 1) {
                assert.equal(input.refinement, undefined);
                return success({ urlContextMetadata: undefined });
            }
            assert.deepEqual(input.candidateUrls, [source]);
            assert.equal(input.interimAnswer, text);
            assert.equal(input.criteria.role, search.role);
            assert.equal(input.criteria.location, search.where);
            assert.equal(input.date, '2026-10-27');
            assert.equal(input.country, 'United Kingdom');
            return success();
        },
    });
    assert.equal(calls, 2);
    assert.equal(usage, 2);
    assert.equal(result.text, text);
    assert.deepEqual(result.cards, [{ ...originalCard, sourceIndexes: [0] }]);
});

test('no plausible literal individual advert URLs means no second billable phase', async () => {
    let calls = 0;
    const batch = cardBatch([
        {
            ...originalCard,
            url: 'https://www.civilservicejobs.service.gov.uk/csr/index.cgi?SID=search',
        },
    ]);
    const result = await searchChatGoogleWeb(search, 'uk', {
            generate: async () => {
                calls++;
                return success({
                    body: {
                        candidates: [
                            { content: { parts: [{ text: batch.answer }] } },
                        ],
                    },
                    groundingMetadata: batch.metadata,
                    urlContextMetadata: undefined,
                });
            },
        });
    assert.deepEqual(result.cards, []);
    assert.equal(calls, 1);
});

test('model-only JSON without real initial Google search attribution cannot trigger refinement', async () => {
    let calls = 0;
    await assert.rejects(
        searchChatGoogleWeb(search, 'uk', {
            generate: async () => {
                calls++;
                return success({
                    groundingMetadata: undefined,
                    urlContextMetadata: undefined,
                });
            },
        }),
        ChatGoogleWebError,
    );
    assert.equal(calls, 1);
});

test('a failed final native-proof gate never produces a third provider phase or displays the interim', async () => {
    let calls = 0;
    await assert.rejects(
        searchChatGoogleWeb(search, 'uk', {
            generate: async () => {
                calls++;
                return success({ urlContextMetadata: undefined });
            },
        }),
        ChatGoogleWebError,
    );
    assert.equal(calls, 2);
});

test('only the refined original answer is displayed after source dates are corrected', async () => {
    const first = cardBatch([{ ...originalCard, closingDate: '2026-10-26' }]);
    const final = cardBatch([{ ...originalCard, closingDate: '2026-10-29' }]);
    let calls = 0;
    const result = await searchChatGoogleWeb(search, 'uk', {
        now: () => Date.parse('2026-10-27T12:00:00Z'),
        generate: async () => {
            const batch = ++calls === 1 ? first : final;
            return success({
                body: {
                    candidates: [
                        { content: { parts: [{ text: batch.answer }] } },
                    ],
                },
                groundingMetadata: batch.metadata,
                urlContextMetadata: batch.context,
            });
        },
    });
    assert.equal(calls, 2);
    assert.equal(result.text, final.answer);
    assert.equal(result.cards?.[0]?.closingDate, '2026-10-29');
    assert.equal(result.searchResearch?.text, first.answer);
    assert.equal(result.text.includes('2026-10-26'), false);
});

test('refinement can retain associated original search suggestions but never interim source or citation spans', async () => {
    let calls = 0;
    const result = await searchChatGoogleWeb(search, 'uk', {
        generate: async () =>
            ++calls === 1
                ? success({ urlContextMetadata: undefined })
                : success({
                      groundingMetadata: {
                          ...grounding(),
                          searchQueries: [],
                          searchSuggestions: [],
                      },
                  }),
    });
    assert.equal(calls, 2);
    assert.deepEqual(result.searchQueries, grounding().searchQueries);
    assert.deepEqual(result.searchSuggestions, grounding().searchSuggestions);
    let nativeCalls = 0;
    const native = await searchChatGoogleWeb(search, 'uk', {
            generate: async () =>
                ++nativeCalls === 1
                    ? success({ urlContextMetadata: undefined })
                    : success({
                          groundingMetadata: {
                              ...grounding(),
                              sources: [],
                              citations: [],
                          },
                      }),
        });
    assert.equal(nativeCalls, 2);
    assert.deepEqual(native.citations, []);
    assert.deepEqual(native.searchResearch?.citations, grounding().citations);
    assert.deepEqual(native.retrievedUrls, [source]);
});

test('a shared Google deadline prevents a late first response from starting refinement', async () => {
    let calls = 0;
    await assert.rejects(
        searchChatGoogleWeb(search, 'uk', {
            timeoutMs: 15,
            generate: async () => {
                calls++;
                await new Promise<void>((resolve) => setTimeout(resolve, 30));
                return success({ urlContextMetadata: undefined });
            },
        }),
        ChatGoogleWebError,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 1);
});

test('a stalled refinement shares the original deadline rather than restarting thirty seconds', async () => {
    let calls = 0;
    const budgets: number[] = [];
    await assert.rejects(
        searchChatGoogleWeb(search, 'uk', {
            timeoutMs: 25,
            generate: async (_operation, _request, options) => {
                budgets.push(options?.timeoutMs || 0);
                if (++calls === 1) {
                    await new Promise<void>((resolve) =>
                        setTimeout(resolve, 5),
                    );
                    return success({ urlContextMetadata: undefined });
                }
                return new Promise<OrchestratorSuccess>(() => {});
            },
        }),
        ChatGoogleWebError,
    );
    assert.equal(calls, 2);
    assert.ok(budgets[1]! <= budgets[0]! && budgets[0]! <= 25);
});

test('a route-supplied occupation check replaces the default headline check, and its rejection still fails closed', async () => {
    const seen: string[][] = [];
    const accepted = await searchChatGoogleWeb(chatSearchSchema.parse({ ...search, role: 'software engineer' }), 'uk', {
        generate: async () => success(),
        roleMatches: (title, role) => { seen.push([title, role]); return true; },
    });
    assert.equal(accepted.cards!.length, 1);
    assert.deepEqual(seen.map(([, role]) => role), ['software engineer']);
    let calls = 0;
    await assert.rejects(searchChatGoogleWeb(search, 'uk', {
        generate: async () => { calls++; return success(); },
        roleMatches: () => false,
    }), ChatGoogleWebError);
    assert.equal(calls, 2);
});
