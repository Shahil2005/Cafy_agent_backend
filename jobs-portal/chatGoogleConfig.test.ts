import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    getPrimaryGeminiModel,
    getWebDiscoveryModel,
    supportsStructuredWebDiscovery,
} from '../ai/config';
import { buildGenerationConfig } from '../ai/profiles';
import { buildServerControlledPayload } from '../ai/geminiCore';
import { executeAiGeneration } from '../ai/orchestrator';
import { WEB_DISCOVERY_RESPONSE_SCHEMA } from '../ai/webDiscoverySchema';

function withEnvironment(values: Record<string, string | undefined>): () => void {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

test('web discovery accepts structured-tool model families only', () => {
    for (const name of ['gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-4-argon'])
        assert.equal(supportsStructuredWebDiscovery(name), true);
    for (const name of ['gemini-2.5-flash', 'gpt-4o-mini', 'gemini-3', 'https://other.test/model'])
        assert.equal(supportsStructuredWebDiscovery(name), false);
});

test('web model configuration is independent of the ordinary AI model', () => {
    const restore = withEnvironment({
        AI_PRIMARY_MODEL: 'gemini-2.5-flash',
        AI_WEB_SEARCH_MODEL: undefined,
    });
    try {
        assert.equal(getWebDiscoveryModel(), 'gemini-3.5-flash-lite');
        assert.equal(getPrimaryGeminiModel(), 'gemini-2.5-flash');
        process.env.AI_WEB_SEARCH_MODEL = ' gemini-3-flash-preview ';
        assert.equal(getWebDiscoveryModel(), 'gemini-3-flash-preview');
        process.env.AI_WEB_SEARCH_MODEL = 'gemini-2.5-flash';
        assert.equal(getWebDiscoveryModel(), 'gemini-3.5-flash-lite');
    } finally {
        restore();
    }
});

test('web responses use a native schema allowing a completed zero-result search', () => {
    const config = buildGenerationConfig('jobs_web_discovery', {
        model: 'gemini-3.5-flash-lite',
    });
    assert.equal(config.responseMimeType, 'application/json');
    assert.equal(config.responseJsonSchema, WEB_DISCOVERY_RESPONSE_SCHEMA);
    assert.equal(config.thinkingConfig, undefined);
    const schema = WEB_DISCOVERY_RESPONSE_SCHEMA as any;
    assert.equal(schema.properties.cards.minItems, 0);
    assert.equal(schema.properties.cards.maxItems, 2);
    assert.equal(schema.additionalProperties, false);
    const item = schema.properties.cards.items;
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(item.required, Object.keys(item.properties));
    assert.equal(item.properties.sourceIndexes, undefined);
    for (const field of ['salary', 'employmentType', 'workingArrangement', 'closingDate', 'postedDate'])
        assert.ok(item.properties[field].type.includes('null'));
});

test('web generation cannot silently run structured tools on an older model', () => {
    assert.throws(
        () => buildGenerationConfig('jobs_web_discovery', { model: 'gemini-2.5-flash' }),
        /structured-tool-capable/,
    );
});

test('the server owns both discovery tools and the native response contract', () => {
    const payload = buildServerControlledPayload(
        'jobs_web_discovery',
        {
            contents: [{ role: 'user', parts: [{ text: 'Find software jobs' }] }],
            generationConfig: { responseMimeType: 'text/plain', maxOutputTokens: 99999 },
            tools: [],
        } as any,
        'gemini-3.5-flash-lite',
    );
    assert.deepEqual(payload.tools, [{ urlContext: {} }]);
    const generation = payload.generationConfig as Record<string, unknown>;
    assert.equal(generation.responseMimeType, 'application/json');
    assert.equal(generation.responseJsonSchema, WEB_DISCOVERY_RESPONSE_SCHEMA);
    assert.equal(generation.maxOutputTokens, 3072);
});

test('ordinary chat retains its model-specific JSON and thinking configuration', () => {
    const config = buildGenerationConfig('jobs_search_chat', { model: 'gemini-2.5-flash' });
    assert.equal(config.responseMimeType, 'application/json');
    assert.equal(config.responseJsonSchema, undefined);
    assert.deepEqual(config.thinkingConfig, { thinkingBudget: 0 });
});

test('the search phase uses only native Google Search without JSON mode', () => {
    const payload = buildServerControlledPayload(
        'jobs_web_discovery',
        {
            contents: [{ role: 'user', parts: [{ text: 'Find analyst adverts' }] }],
            systemInstruction: { parts: [{ text: 'Find individual advert sources.' }] },
            webDiscoveryPhase: 'search',
        },
        'gemini-3.5-flash-lite',
    );
    assert.deepEqual(payload.tools, [{ googleSearch: {} }]);
    const config = payload.generationConfig as Record<string, unknown>;
    assert.equal(config.maxOutputTokens, 1536);
    assert.equal(config.responseMimeType, undefined);
    assert.equal(config.responseJsonSchema, undefined);
    assert.equal(payload.webDiscoveryPhase, undefined);
});

test('the server extract phase uses plain URL Context while ignoring client output and tool overrides', () => {
    const request = {
        contents: [{ role: 'user', parts: [{ text: 'Read the supplied advert URLs' }] }],
        systemInstruction: { parts: [{ text: 'Extract original vacancy details.' }] },
        webDiscoveryPhase: 'extract' as const,
        generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: { type: 'string' },
            maxOutputTokens: 99999,
            temperature: 2,
        },
        tools: [{ googleSearch: {} }],
    };
    const payload = buildServerControlledPayload('jobs_web_discovery', request, 'gemini-3.5-flash-lite');
    assert.deepEqual(payload.tools, [{ urlContext: {} }]);
    const config = payload.generationConfig as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(config, 'responseMimeType'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(config, 'responseJsonSchema'), false);
    assert.equal(config.maxOutputTokens, 3072);
    assert.equal(config.temperature, 0);
    assert.equal(payload.webDiscoveryPhase, undefined);
    const { webDiscoveryPhase: omitted, ...defaultRequest } = request;
    const legacy = buildServerControlledPayload('jobs_web_discovery', defaultRequest, 'gemini-3.5-flash-lite');
    const legacyConfig = legacy.generationConfig as Record<string, unknown>;
    assert.deepEqual(legacy.tools, [{ urlContext: {} }]);
    assert.equal(legacyConfig.responseMimeType, 'application/json');
    assert.equal(legacyConfig.responseJsonSchema, WEB_DISCOVERY_RESPONSE_SCHEMA);
    assert.equal(legacyConfig.maxOutputTokens, 3072);
});

test('unrecognised phases cannot introduce custom tools and other operations ignore web phases', () => {
    const request = {
        contents: [{ role: 'user', parts: [{ text: 'Find jobs' }] }],
        systemInstruction: { parts: [{ text: 'Find adverts.' }] },
        webDiscoveryPhase: 'custom-tools',
        tools: [{ codeExecution: {} }],
    } as any;
    assert.throws(
        () => buildServerControlledPayload('jobs_web_discovery', request, 'gemini-3.5-flash-lite'),
        /Invalid server web discovery phase/,
    );
    request.webDiscoveryPhase = 'search';
    const normal = buildServerControlledPayload('jobs_search_chat', request, 'gemini-2.5-flash');
    const config = normal.generationConfig as Record<string, unknown>;
    assert.equal(normal.tools, undefined);
    assert.equal(config.responseMimeType, 'application/json');
    assert.equal(config.maxOutputTokens, 1024);
    assert.equal(config.responseJsonSchema, undefined);
});

test('a failed discovery request never falls back to old Gemini or OpenAI', async () => {
    const restore = withEnvironment({
        GEMINI_API_KEY: 'offline-test-key',
        OPENAI_API_KEY: 'offline-test-key',
        AI_PRIMARY_MODEL: 'gemini-2.5-flash',
        AI_WEB_SEARCH_MODEL: 'gemini-3.5-flash-lite',
        AI_PRIMARY_MAX_ATTEMPTS: '1',
        AI_GEMINI_FALLBACK_MODEL: 'gemini-2.5-flash-lite',
        AI_GEMINI_FALLBACK_MAX_ATTEMPTS: '1',
        AI_RETRY_BACKOFF_MS: '0',
        BETA_MODE: 'true',
    });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
        requests.push(String(input));
        return new Response('offline provider failure', { status: 503 });
    };
    try {
        const result = await executeAiGeneration(
            'jobs_web_discovery',
            {
                systemInstruction: { parts: [{ text: 'Find source-supported adverts.' }] },
                contents: [{ role: 'user', parts: [{ text: 'Find analyst jobs' }] }],
            },
            { primaryModel: 'gpt-4o-mini', timeoutMs: 1000, maxTotalAttempts: 8 },
        );
        assert.equal(result.ok, false);
        assert.deepEqual(requests, [
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
        ]);
    } finally {
        globalThis.fetch = originalFetch;
        restore();
    }
});
