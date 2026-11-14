import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { executeAiGeneration } from '../ai/orchestrator';
import { cutAtSentence, runAgent } from './agent';
import type { AgentEvent } from './contract';
import { appendMessages, newConversation, withoutLastPair } from './conversations';
import { indexCv, searchCv, wordOverlapScorer } from './cv';
import { extractCvProfile } from './cv/profile';
import { createAgentTurnHandler } from './handler';
import { memoryStores } from './testStores';
import { defineTool } from './tools';
import { createUkTools } from './tools/uk';

function model(outputs: string[]): typeof executeAiGeneration {
    return async () => {
        const text = outputs.shift();
        if (text === undefined) return { ok: false, status: 500, errorText: 'none' };
        return { ok: true, body: { candidates: [{ content: { parts: [{ text }] } }] }, provider: 'gemini', model: 'gemini-2.5-flash-lite', attempts: 1, latencyMs: 1 };
    };
}
const sink = () => {
    const events: AgentEvent[] = [];
    return { events, sink: { send: (e: AgentEvent) => events.push(e), closed: false } };
};

test('extra pieces, chips and tool calls are sliced, and a long answer is kept', async () => {
    const long = 'This is a sentence about careers. '.repeat(300);
    const ui = Array.from({ length: 20 }, (_, i) => ({ type: 'tips', items: [`tip ${i}`] }));
    const suggestions = Array.from({ length: 10 }, (_, i) => `Question number ${i}?`);
    const s = sink();
    const run = await runAgent({ uid: 'u', message: 'x', history: [] }, s.sink, new AbortController().signal, {
        generate: model([JSON.stringify({ answer: { text: long, ui, suggestions } })]),
        tools: [],
    });
    assert.ok(run.answer, 'answer kept instead of failing');
    assert.ok(run.answer.text.length <= 8000 && run.answer.text.endsWith('.'));
    assert.equal(run.answer.pieces.length, 12);
    assert.equal(run.answer.suggestions.length, 4);
    assert.equal(cutAtSentence('Short.'), 'Short.');
});

test('the same tool call twice in one turn runs once', async () => {
    let runs = 0;
    const tool = defineTool({ name: 'echo', description: 'e', args: z.object({ w: z.string() }).strict(), label: () => 'Echo', run: async () => { runs++; return { ok: 1 }; } });
    const call = JSON.stringify({ toolCalls: [{ name: 'echo', args: { w: 'a' } }, { name: 'echo', args: { w: 'a' } }, { name: 'echo', args: { w: 'b' } }, { name: 'echo', args: { w: 'c' } }] });
    const s = sink();
    await runAgent({ uid: 'u', message: 'x', history: [] }, s.sink, new AbortController().signal, {
        generate: model([call, JSON.stringify({ answer: { text: 'Done.' } })]),
        tools: [tool],
    });
    assert.equal(runs, 2, 'duplicate skipped; 4th call sliced off (max 3 per step)');
});

const CV = 'EXPERIENCE\nData Analyst Intern, Northwind Retail, Jun 2023 - Aug 2023\nBuilt weekly dashboards in Power BI and automated reporting with Python.\nSKILLS\nPython, SQL, Power BI';
const PROFILE = JSON.stringify({ documentType: 'cv', headline: 'Analyst', roles: [{ title: 'Data Analyst Intern', evidence: 'Data Analyst Intern, Northwind Retail' }], skills: [{ name: 'Python', source: 'experience', evidence: 'automated reporting with Python' }] });

test('if embedding is down, the CV still works and search falls back to words', async () => {
    const stores = memoryStores();
    const { index } = await indexCv('u', { name: 'CV.pdf', text: CV }, {
        signal: new AbortController().signal,
        store: stores.cvStore,
        embed: async () => { throw new Error('edge function down'); },
        extract: (t, o) => extractCvProfile(t, { ...o, generate: model([PROFILE]) }),
    });
    assert.ok(index.chunks.every((c) => c.embedding.length === 0));
    const hits = await searchCv(index, 'Power BI dashboards', { embed: async () => { throw new Error('still down'); } });
    assert.match(hits[0]!.text, /Power BI/);
    assert.ok(wordOverlapScorer('python')({ text: 'Python, SQL', section: 'Skills' }) > 0);
    // Next time the CV is chosen and embedding works again, vectors are filled in.
    const again = await indexCv('u', { name: 'CV.pdf', text: CV }, { signal: new AbortController().signal, store: stores.cvStore, embed: async (t) => t.map(() => [1, 0]) });
    assert.ok(again.index.chunks.every((c) => c.embedding.length === 2));
});

test('regenerate replaces the previous pair instead of duplicating it', () => {
    let c = appendMessages(newConversation('q'), [{ role: 'user', text: 'Q1', at: 1 }, { role: 'assistant', text: 'A1', at: 1 }]);
    c = appendMessages(withoutLastPair(c, 'Q1'), [{ role: 'user', text: 'Q1', at: 2 }, { role: 'assistant', text: 'A1 better', at: 2 }]);
    assert.deepEqual(c.messages.map((m) => m.text), ['Q1', 'A1 better']);
    assert.equal(withoutLastPair(c, 'other question').messages.length, 2, 'only the matching pair is replaced');
});

test('a very long conversation stays under the document size limit', () => {
    let c = newConversation('q');
    const big = 'x'.repeat(30_000);
    for (let i = 0; i < 40; i++) c = appendMessages(c, [{ role: 'user', text: `q${i}`, at: i }, { role: 'assistant', text: big, at: i }]);
    assert.ok(JSON.stringify(c.messages).length <= 800_000);
    assert.equal(c.messages[c.messages.length - 2]!.text, 'q39', 'newest messages kept');
});

async function turn(deps: Parameters<typeof createAgentTurnHandler>[0], body: unknown) {
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/t', (req, _res, next) => { (req as any).user = { uid: 'u1' }; next(); }, createAgentTurnHandler(deps));
    const server = app.listen(0);
    try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/t`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return (await res.text()).split('\n\n').filter(Boolean).map((c) => JSON.parse(c.replace(/^data: /, ''))) as AgentEvent[];
    } finally {
        server.close();
    }
}

test('a turn from another tab is not overwritten, and an expired CV is reported', async () => {
    const stores = memoryStores();
    const conv = { ...appendMessages(newConversation('start'), [{ role: 'user', text: 'tab A question', at: 1 }, { role: 'assistant', text: 'tab A answer', at: 1 }]), cvHash: 'gone', cvName: 'Old.pdf' };
    stores.convs.set(conv.id, conv);
    const base = { hasAccess: async () => true, consume: async () => ({ allowed: true, used: 1, limit: 99 }), conversations: stores.conversations, cvStore: stores.cvStore, tools: [] };
    // Simulate tab B saving while this turn is running.
    const generate: typeof executeAiGeneration = async (...a) => {
        const latest = stores.convs.get(conv.id);
        stores.convs.set(conv.id, appendMessages(latest, [{ role: 'user', text: 'tab B question', at: 2 }, { role: 'assistant', text: 'tab B answer', at: 2 }]));
        return model([JSON.stringify({ answer: { text: 'Answer for this tab.' } })])(...a);
    };
    const events = await turn({ ...base, generate }, { conversationId: conv.id, message: 'tab A follow-up' });
    assert.ok(events.some((e) => e.type === 'cv' && e.name === null), 'CV bar told the CV is gone');
    assert.ok(events.some((e) => e.type === 'block' && e.block.kind === 'cvPicker'));
    const texts = stores.convs.get(conv.id).messages.map((m: { text: string }) => m.text);
    assert.ok(texts.includes('tab B answer') && texts.includes('Answer for this tab.'), texts.join(' | '));
    assert.equal(stores.convs.get(conv.id).cvHash, undefined);
});

test('unknown SOC codes and weak matches are flagged', async () => {
    const [soc, visa] = createUkTools({ match: async () => [{ soc_code: '2134', similarity: 0.7 }], choose: async () => null });
    const ctx = { uid: 'u', signal: new AbortController().signal, cv: null, emit: () => undefined };
    assert.equal(((await visa!.run({ socCode: '9999' }, ctx)) as { error?: string }).error, 'UNKNOWN_SOC');
    assert.equal(((await soc!.run({ query: 'something unusual' }, ctx)) as { lowConfidence?: boolean }).lowConfidence, true);
    assert.equal(((await soc!.run({ query: 'software engineer' }, ctx)) as { lowConfidence?: boolean }).lowConfidence, undefined, 'official title match is confident');
});
