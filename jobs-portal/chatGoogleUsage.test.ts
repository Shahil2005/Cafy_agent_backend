import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callGemini } from '../ai/geminiCore';
import { executeAiGeneration } from '../ai/orchestrator';
import { billableTokenUsage } from '../ai/tokenUsage';
import type { GenerationDiagnostics } from '../ai/types';

const request = { contents: [], systemInstruction: {} };

/** No dotenv file or owner environment value is inspected by these tests. */
async function withSyntheticEnvironment(task: () => Promise<void>): Promise<void> {
    const previousEnvironment = process.env;
    process.env = {
        GEMINI_API_KEY: 'fake-offline-usage-test-key',
        AI_PRIMARY_MAX_ATTEMPTS: '1',
        AI_RETRY_BACKOFF_MS: '0',
    };
    try {
        await task();
    } finally {
        process.env = previousEnvironment;
    }
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function mockGeneration(context: { mock: { method: (object: typeof globalThis, method: 'fetch', implementation: typeof fetch) => unknown } }, usageMetadata: Record<string, unknown>, empty = false): void {
    context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        candidates: [{
            finishReason: 'STOP',
            content: { parts: empty ? [] : [{ text: 'Offline response fixture' }] },
        }],
        usageMetadata,
    }), { status: 200 }));
}

test('billable usage includes URL retrieval input and thinking output', () => {
    // Same accounting categories as the official URL Context token-count example.
    assert.deepEqual(billableTokenUsage({
        promptTokens: 27,
        toolUsePromptTokens: 10309,
        outputTokens: 45,
        thoughtsTokens: 31,
        totalTokens: 10412,
    }), { inputTokens: 10336, outputTokens: 76, totalTokens: 10412 });
});

test('missing counters stay unknown rather than becoming zero-cost usage', () => {
    assert.deepEqual(billableTokenUsage(), {});
    assert.deepEqual(billableTokenUsage({}), {});
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, outputTokens: 45 }), {});
    assert.deepEqual(billableTokenUsage({ totalTokens: 10412 }), { totalTokens: 10412 });
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, toolUsePromptTokens: 10309 }), { inputTokens: 10336 });
    assert.deepEqual(billableTokenUsage({ outputTokens: 45, thoughtsTokens: 31 }), { outputTokens: 76 });
});

test('native totals prove omitted zero counters without guessing a positive remainder', () => {
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, outputTokens: 45, totalTokens: 72 }), {
        inputTokens: 27, outputTokens: 45, totalTokens: 72,
    });
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, outputTokens: 45, totalTokens: 100 }), { totalTokens: 100 });
    assert.deepEqual(billableTokenUsage({ totalTokens: 0 }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, toolUsePromptTokens: 0, outputTokens: 45, totalTokens: 100 }), {
        inputTokens: 27, outputTokens: 73, totalTokens: 100,
    });
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, outputTokens: 45, thoughtsTokens: 0, totalTokens: 100 }), {
        inputTokens: 55, outputTokens: 45, totalTokens: 100,
    });
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, outputTokens: 45, totalTokens: 10 }), {});
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, toolUsePromptTokens: 0, outputTokens: 45, thoughtsTokens: 0, totalTokens: 100 }), { totalTokens: 100 });
    assert.deepEqual(billableTokenUsage({ promptTokens: 27, toolUsePromptTokens: 0, outputTokens: 45, thoughtsTokens: 0 }), {
        inputTokens: 27, outputTokens: 45, totalTokens: 72,
    });
});

test('explicit zero counters are preserved and invalid counts are rejected', () => {
    assert.deepEqual(billableTokenUsage({
        promptTokens: 0, toolUsePromptTokens: 0, outputTokens: 0, thoughtsTokens: 0,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    for (const invalid of [-1, 0.5, NaN, Infinity, 1_000_000_001, '12', null]) {
        assert.deepEqual(billableTokenUsage({
            promptTokens: invalid, toolUsePromptTokens: 0,
            outputTokens: invalid, thoughtsTokens: 0,
        } as GenerationDiagnostics), {});
    }
});

test('native Google usage counters survive the provider and orchestrator', async (context) => {
    await withSyntheticEnvironment(async () => {
        mockGeneration(context, {
            promptTokenCount: 27,
            toolUsePromptTokenCount: 10309,
            candidatesTokenCount: 45,
            thoughtsTokenCount: 31,
            totalTokenCount: 10412,
        });
        const direct = await callGemini('jobs_web_discovery', request, 'gemini-3.5-flash-lite');
        assert.equal(direct.ok, true);
        if (!direct.ok) return;
        assert.equal(direct.toolUsePromptTokens, 10309);
        assert.equal(direct.totalTokens, 10412);
        const result = await executeAiGeneration('jobs_web_discovery', request, { maxTotalAttempts: 1 });
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.diagnostics?.toolUsePromptTokens, 10309);
        assert.equal(result.diagnostics?.totalTokens, 10412);
        assert.deepEqual(billableTokenUsage(result.diagnostics), { inputTokens: 10336, outputTokens: 76, totalTokens: 10412 });
        assert.ok(!JSON.stringify(result.diagnostics).includes('Offline response fixture'));
    });
});

test('absent native usage fields do not add undefined properties to old diagnostics', async (context) => {
    await withSyntheticEnvironment(async () => {
        mockGeneration(context, { promptTokenCount: 27, candidatesTokenCount: 45 });
        const direct = await callGemini('jobs_web_discovery', request, 'gemini-3.5-flash-lite');
        assert.equal(direct.ok, true);
        if (!direct.ok) return;
        assert.equal(hasOwn(direct, 'toolUsePromptTokens'), false);
        assert.equal(hasOwn(direct, 'totalTokens'), false);
        const result = await executeAiGeneration('jobs_web_discovery', request, { maxTotalAttempts: 1 });
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(hasOwn(result.diagnostics!, 'toolUsePromptTokens'), false);
        assert.equal(hasOwn(result.diagnostics!, 'totalTokens'), false);
    });
});

test('native diagnostic extraction accepts zero and bounds untrusted tool and total counts', async (context) => {
    await withSyntheticEnvironment(async () => {
        for (const invalid of [-1, 0.5, NaN, Infinity, 1_000_000_001, '12', null, {}, []]) {
            mockGeneration(context, { toolUsePromptTokenCount: invalid, totalTokenCount: invalid });
            const result = await callGemini('jobs_web_discovery', request, 'gemini-3.5-flash-lite');
            assert.equal(result.ok, true);
            if (!result.ok) continue;
            assert.equal(hasOwn(result, 'toolUsePromptTokens'), false);
            assert.equal(hasOwn(result, 'totalTokens'), false);
        }
        mockGeneration(context, { toolUsePromptTokenCount: 0, totalTokenCount: 0 });
        const result = await callGemini('jobs_web_discovery', request, 'gemini-3.5-flash-lite');
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.toolUsePromptTokens, 0);
        assert.equal(result.totalTokens, 0);
    });
});

test('empty generation failures retain bounded usage diagnostics without generated content', async (context) => {
    await withSyntheticEnvironment(async () => {
        mockGeneration(context, { toolUsePromptTokenCount: 600, totalTokenCount: 610 }, true);
        const result = await callGemini('jobs_web_discovery', request, 'gemini-3.5-flash-lite');
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.diagnostics?.toolUsePromptTokens, 600);
        assert.equal(result.diagnostics?.totalTokens, 610);
        assert.equal(hasOwn(result.diagnostics!, 'text'), false);
        assert.equal(hasOwn(result.diagnostics!, 'contents'), false);
    });
});
