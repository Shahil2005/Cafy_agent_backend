/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { executeAiGeneration } from '../ai/orchestrator';
import { runAgent } from './agent';
import { MAX_MESSAGE_CHARS, type AgentEvent } from './contract';
import { createAgentTurnHandler, createConversationHandlers } from './handler';
import { acquireTurnLock, lockKey, type LockStore } from './lock';
import { isAgentDocPath, runAgentRetention, type RetentionStore } from './retention';
import { forcedToolCalls } from './routing';
import { AGENT_TOOLS, defineTool } from './tools';
import { readDailyUsage, recordDailyUsage, usageKey, type UsageStore } from './usage';
import { memoryStores } from './testStores';

type Generate = typeof executeAiGeneration;

const reply = (text: string) => JSON.stringify({ answer: { text, suggestions: ['Next?'] } });
const ok = (output: string): Awaited<ReturnType<Generate>> =>
    ({ ok: true, status: 200, model: 'gemini-2.5-flash-lite', latencyMs: 1, body: { candidates: [{ content: { parts: [{ text: output }] } }] } }) as any;

function memoryLock(): LockStore & { keys: Map<string, string> } {
    const keys = new Map<string, string>();
    return {
        keys,
        async set(key, value, options) {
            if (options.nx && keys.has(key)) return null;
            keys.set(key, value);
            return 'OK';
        },
        async eval(_script, [key], [token]) {
            if (keys.get(key!) === token) keys.delete(key!);
            return 1;
        },
    };
}

async function post(deps: Parameters<typeof createAgentTurnHandler>[0], body: unknown, uid = 'u1') {
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.post('/t', (req, _res, next) => { (req as any).user = { uid }; next(); }, createAgentTurnHandler(deps));
    const server = app.listen(0);
    try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/t`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const text = await res.text();
        const events = res.headers.get('content-type')?.includes('event-stream')
            ? (text.split('\n\n').filter(Boolean).map((c) => JSON.parse(c.replace(/^data: /, ''))) as AgentEvent[])
            : [];
        return { status: res.status, text, events };
    } finally {
        server.close();
    }
}

const base = () => ({ hasAccess: async () => true, consume: async () => ({ allowed: true, used: 1, limit: 99 }), usageStore: null, tools: [], ...memoryStores() });

// ---------- One answer at a time, and every turn ends in time ----------

test('only one answer at a time per user; the lock frees only its own turn', async () => {
    const store = memoryLock();
    const first = await acquireTurnLock('u1', store);
    assert.equal(first.acquired, true);
    assert.equal((await acquireTurnLock('u1', store)).acquired, false, 'second tab must wait');
    assert.equal((await acquireTurnLock('u2', store)).acquired, true, 'other users are not blocked');
    store.keys.set(lockKey('u1'), 'someone-else');
    await first.release();
    assert.equal(store.keys.has(lockKey('u1')), true, 'a late release never frees a newer turn');
    assert.doesNotMatch(lockKey('u1'), /u1/, 'raw uid never appears in Redis keys');
    const broken: LockStore = { set: async () => { throw new Error('down'); }, eval: async () => 0 };
    assert.equal((await acquireTurnLock('u1', broken)).acquired, true, 'Redis outage fails open (rate limiter still applies)');
});

test('a second simultaneous turn gets 409 without any AI call, and the lock is released after a turn', async () => {
    let called = 0;
    const generate: Generate = async () => { called++; return ok(reply('Hello!')); };
    const busy = await post({ ...base(), generate, lock: async () => ({ acquired: false, release: async () => undefined }) }, { message: 'hi' });
    assert.equal(busy.status, 409);
    assert.match(busy.text, /BUSY/);
    assert.equal(called, 0);
    const store = memoryLock();
    await post({ ...base(), generate, lock: (uid) => acquireTurnLock(uid, store) }, { message: 'hi' });
    assert.equal(store.keys.size, 0, 'lock freed once the answer is done');
    assert.equal((await acquireTurnLock('u1', store)).acquired, true, 'the next message is accepted');
});

test('a turn that runs out of time ends with a clear retryable message', async () => {
    const generate: Generate = (_op, _req, opts) => new Promise((resolve) => {
        opts?.signal?.addEventListener('abort', () => resolve({ ok: false, status: 499, errorText: 'aborted' } as any));
    });
    const started = Date.now();
    const res = await post({ ...base(), generate, turnDeadlineMs: 300 }, { message: 'How do I write a cover letter?' });
    assert.ok(Date.now() - started < 5_000);
    const error = res.events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }> | undefined;
    assert.ok(error?.retryable);
    assert.match(error!.message, /longer than expected/);
});

test('near the deadline the model must answer, and no more lookups run', async () => {
    const prompts: string[] = [];
    let toolRuns = 0;
    const tool = defineTool({ name: 'lookup', description: 'x', args: z.object({}).strict(), label: () => 'Looking', run: async () => { toolRuns++; return {}; } });
    const generate: Generate = async (_op, request) => {
        prompts.push((request.contents as any)[0].parts[0].text);
        return ok(JSON.stringify({ toolCalls: [{ name: 'lookup', args: {} }], answer: { text: 'Here is what I have.' } }));
    };
    const events: AgentEvent[] = [];
    const run = await runAgent(
        { uid: 'u', message: 'question', history: [], deadlineAt: Date.now() + 5_000 },
        { send: (e) => events.push(e), closed: false },
        new AbortController().signal,
        { generate, tools: [tool] },
    );
    assert.equal(run.answer?.text, 'Here is what I have.');
    assert.match(prompts[0]!, /Give the final answer now/);
    assert.equal(toolRuns, 0);
});

test('at most 6 lookups run in one turn, whatever the model asks for', async () => {
    let toolRuns = 0;
    const tool = defineTool({ name: 'lookup', description: 'x', args: z.object({ q: z.string() }).strict(), label: () => 'Looking', run: async () => { toolRuns++; return {}; } });
    let step = 0;
    const generate: Generate = async () => {
        step++;
        const calls = [1, 2, 3].map((i) => ({ name: 'lookup', args: { q: `${step}-${i}` } }));
        return ok(JSON.stringify(step < 5 ? { toolCalls: calls } : { answer: { text: 'Done.' } }));
    };
    await runAgent({ uid: 'u', message: 'q', history: [] }, { send: () => undefined, closed: false }, new AbortController().signal, { generate, tools: [tool] });
    assert.equal(toolRuns, 6);
});

// ---------- Safe direct routing (data first, the model still decides) ----------

test('own-CV questions fetch the right CV data first; general questions do not', () => {
    const all = new Set(AGENT_TOOLS.map((t) => t.name));
    const names = (message: string, hasCv = true) => forcedToolCalls(message, all, { hasCv }).map((c) => c.name);
    assert.deepEqual(names('How many years of experience do I have?'), ['get_cv_profile', 'get_experience_years']);
    assert.deepEqual(names('Can you summarise my CV?'), ['get_cv_profile']);
    assert.deepEqual(names('Which SOC code fits my CV?'), ['get_cv_profile', 'soc_lookup']);
    assert.deepEqual(names('Where did I study?'), ['get_cv_profile'], 'any first-person question gets the whole profile');
    assert.deepEqual(names('How many years of experience do I have?', false), [], 'no CV: nothing to fetch');
    assert.deepEqual(names('How many years of experience do I need for a Skilled Worker visa?', false), ['gov_uk_guidance'], 'a visa rule, not the user\'s CV');
    assert.deepEqual(names('What does a data analyst do?'), []);
});

test('sponsor questions look the company up in the official register first', () => {
    const all = new Set(AGENT_TOOLS.map((t) => t.name));
    const sponsorArgs = (message: string) => forcedToolCalls(message, all).find((c) => c.name === 'find_sponsors')?.args;
    assert.deepEqual(sponsorArgs('Does Tesco hold a sponsor licence?'), { name: 'Tesco' });
    assert.deepEqual(sponsorArgs('Is Marks and Spencer a licensed sponsor?'), { name: 'Marks and Spencer' });
    assert.deepEqual(sponsorArgs('Does the NHS sponsor Health and Care visas?'), { name: 'NHS' });
    assert.deepEqual(sponsorArgs('Will Google sponsor me?'), { name: 'Google' });
    assert.deepEqual(sponsorArgs('Is HSBC licensed to sponsor Skilled Workers?'), { name: 'HSBC' });
    assert.deepEqual(sponsorArgs('Find licensed sponsors called Accenture in London'), { name: 'Accenture' });
    assert.equal(sponsorArgs('Does a Skilled Worker visa need a sponsor?'), undefined, 'a rule question, not a company');
    assert.deepEqual(sponsorArgs('Do companies in Leeds sponsor visas?'), { city: 'Leeds' }, 'no company named: list that place');
    assert.equal(sponsorArgs('Does Tesco have graduate jobs?'), undefined, 'not about sponsorship');
});

test('fetched data is given to the model, which still writes the answer', async () => {
    const prompts: string[] = [];
    let runs = 0;
    const years = defineTool({ name: 'get_experience_years', description: 'x', args: z.object({}).strict(), label: () => 'Years', run: async () => { runs++; return { years: 3.5 }; } });
    const generate: Generate = async (_op, request) => {
        prompts.push((request.contents as any)[0].parts[0].text);
        return ok(reply('You have about **3.5 years** of experience.'));
    };
    const cv = { version: 2, name: 'CV.pdf', hash: 'h', createdAt: 0, expiresAt: Date.now() + 1e9, text: 'Analyst 2021 - 2024', profile: { roles: [], education: [], skills: [], projects: [], achievements: [], certifications: [], languages: [] }, chunks: [] } as any;
    const run = await runAgent({ uid: 'u', message: 'How many years of experience do I have?', history: [], cv }, { send: () => undefined, closed: false }, new AbortController().signal, { generate, tools: [years] });
    assert.equal(runs, 1);
    assert.equal(prompts.length, 1, 'one AI call instead of two');
    assert.match(prompts[0]!, /"years":3.5/);
    assert.match(run.answer!.text, /3\.5 years/);
});

// ---------- Retention deletes only the agent's own expired documents ----------

test('retention deletes only users/{uid}/agent* documents that have expired', async () => {
    assert.equal(isAgentDocPath('users/u1/agentConversations/abc', 'agentConversations'), true);
    assert.equal(isAgentDocPath('users/u1/resumes/abc', 'agentConversations'), false);
    assert.equal(isAgentDocPath('teams/t/agentConversations/abc', 'agentConversations'), false);
    assert.equal(isAgentDocPath('users/u1/x/y/agentConversations/abc', 'agentConversations'), false);
    const deleted: string[] = [];
    const pages: Record<string, string[][]> = {
        agentConversations: [['users/a/agentConversations/1', 'users/b/agentConversations/2', 'other/x/agentConversations/3']],
        agentCvProfiles: [['users/a/agentCvProfiles/h']],
        agentFeedback: [[]],
    };
    const store: RetentionStore = {
        expired: async (collection) => (pages[collection]!.shift() ?? []).map((path) => ({ path })),
        delete: async (paths) => { deleted.push(...paths); },
    };
    const result = await runAgentRetention(store);
    assert.deepEqual(deleted, ['users/a/agentConversations/1', 'users/b/agentConversations/2', 'users/a/agentCvProfiles/h']);
    assert.equal(result.skippedPaths, 1);
    assert.equal(result.complete, true);
});

test('retention reports a missing index by code only and deletes nothing', async () => {
    const result = await runAgentRetention({
        expired: async () => { throw Object.assign(new Error('needs index: https://console…'), { code: 9 }); },
        delete: async () => { throw new Error('must not delete'); },
    });
    assert.deepEqual(result.errors, ['agentConversations:9', 'agentCvProfiles:9', 'agentFeedback:9']);
    assert.equal(result.complete, false);
});

// ---------- Daily cost totals hold counts only ----------

test('daily usage totals record cost and counts, never text or user ids', async () => {
    const hashes = new Map<string, Record<string, number>>();
    const store: UsageStore = {
        hincrby: async (key, field, n) => { const h = hashes.get(key) ?? {}; h[field] = (h[field] ?? 0) + n; hashes.set(key, h); return h[field]; },
        expire: async () => 1,
        hgetall: async (key) => hashes.get(key) ?? null,
    };
    const now = new Date('2026-11-01T10:00:00Z');
    const calls = [{ step: 1, model: 'gemini-2.5-flash-lite', promptTokens: 1000, outputTokens: 200 }];
    await recordDailyUsage(calls, 'answered', ['soc_lookup', 'soc_lookup'], store, now);
    await recordDailyUsage(calls, 'answered', [], store, now);
    const day = hashes.get(usageKey('20261101'))!;
    assert.equal(day.turns, 2);
    assert.equal(day['tool:soc_lookup'], 1);
    assert.equal(day['outcome:answered'], 2);
    assert.equal(day.usdMicros, 360);
    assert.doesNotMatch(JSON.stringify([...hashes]), /u1|uid/);
    const [today] = await readDailyUsage(store, 1, now);
    assert.equal(today!.usd, 0.0004);
});

// ---------- Privacy: logs never contain what users wrote ----------

test('logs never contain the message, CV text or model output, even on failures', async () => {
    const SECRET = 'ZEBRA-7731-PRIVATE';
    const logged: string[] = [];
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const level of ['log', 'info', 'warn', 'error'] as const) console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    try {
        const failingTool = defineTool({ name: 'boom', description: 'x', args: z.object({}).strict(), label: () => 'Boom', run: async () => { throw new Error(`failed on ${SECRET}`); } });
        let step = 0;
        const generate: Generate = async () => (++step === 1 ? ok(JSON.stringify({ toolCalls: [{ name: 'boom', args: {} }] })) : ok(reply(`Answer mentioning ${SECRET}`)));
        await post({ ...base(), generate, tools: [failingTool] }, { message: `My code is ${SECRET}` });
        await post({ ...base(), generate: async () => ({ ok: false, status: 500, errorText: SECRET }) as any }, { message: `Again ${SECRET}` });
        await post({ ...base(), embed: async () => { throw new Error(SECRET); }, extractCv: async () => { throw new Error(SECRET); } },{ message: 'Use my CV', cv: { name: 'CV.pdf', text: `${SECRET} `.repeat(20) } });
    } finally {
        Object.assign(console, original);
    }
    assert.ok(logged.length > 0, 'usage is still logged');
    assert.equal(logged.filter((line) => line.includes(SECRET)).length, 0, logged.join('\n'));
});

// ---------- Access control and input abuse ----------

test("a user can never read or delete another user's conversation", async () => {
    const byUser = new Map<string, Map<string, any>>([['owner', new Map([['abcdefghij12', { id: 'abcdefghij12', title: 'Mine', messages: [] }]])]]);
    const handlers = createConversationHandlers({
        get: async (uid, id) => byUser.get(uid)?.get(id) ?? null,
        put: async () => undefined,
        list: async (uid) => [...(byUser.get(uid)?.values() ?? [])],
        remove: async (uid, id) => { byUser.get(uid)?.delete(id); },
    });
    const app = express();
    app.use((req, _res, next) => { (req as any).user = { uid: 'attacker' }; next(); });
    app.get('/c/:id', handlers.get);
    app.delete('/c/:id', handlers.remove);
    app.get('/c', handlers.list);
    const server = app.listen(0);
    try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/c`;
        assert.equal((await fetch(`${url}/abcdefghij12`)).status, 404);
        await fetch(`${url}/abcdefghij12`, { method: 'DELETE' });
        assert.equal(byUser.get('owner')!.size, 1, "owner's chat untouched");
        assert.deepEqual(((await (await fetch(url)).json()) as any).conversations, []);
        assert.equal((await fetch(`${url}/..%2F..%2Fresumes`)).status, 400, 'path tricks rejected');
    } finally {
        server.close();
    }
});

test('the user id always comes from the login token, never from the request body', async () => {
    const stores = memoryStores();
    const seen: string[] = [];
    const conversations = { ...stores.conversations, put: async (uid: string, c: any) => { seen.push(uid); await stores.conversations.put(uid, c); } };
    await post({ ...base(), conversations, generate: async () => ok(reply('Hi!')) }, { message: 'hello', uid: 'victim', userId: 'victim' });
    assert.deepEqual([...new Set(seen)], ['u1']);
});

test('oversized, malformed and wrongly typed requests are rejected before any AI call', async () => {
    let called = 0;
    const deps = { ...base(), generate: async () => { called++; return ok(reply('x')); } };
    assert.equal((await post(deps, { message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) })).status, 400);
    assert.equal((await post(deps, { message: 42 })).status, 400);
    assert.equal((await post(deps, { message: 'hi', conversationId: '../../users/other' })).status, 400);
    assert.equal((await post(deps, { message: 'hi', cv: { name: 'a', text: 'short' } })).status, 400);
    assert.equal((await post(deps, { message: 'hi', cv: { name: 'a', text: 'x'.repeat(200), sourceId: 'bad/../id' } })).status, 400);
    assert.equal(called, 0);
});

test('no tool lets the model choose a URL or web address to fetch', () => {
    for (const tool of AGENT_TOOLS) {
        const keys = tool.args instanceof z.ZodObject ? Object.keys(tool.args.shape) : [];
        assert.ok(!keys.some((k) => /url|link|href|endpoint|host|domain/i.test(k)), `${tool.name} takes ${keys.join(',')}`);
    }
});

// ---------- Existing CAFY data is never written ----------

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === 'knowledge' ? sourceFiles(path).filter((f) => f.endsWith('.ts')) : sourceFiles(path);
        return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('testStores.ts') ? [path] : [];
    });
}

test('agent code only writes inside its own folders and never writes to Supabase', () => {
    const ALLOWED = new Set(['users', 'resumes', 'agentConversations', 'agentCvProfiles', 'agentFeedback']);
    for (const file of sourceFiles(__dirname)) {
        const code = readFileSync(file, 'utf8');
        for (const [, name] of code.matchAll(/collection(?:Group)?\('([^']+)'\)/g)) assert.ok(ALLOWED.has(name!), `${file} uses collection ${name}`);
        // The user's resumes are read (to clean up deleted CVs), never written.
        for (const line of code.split('\n').filter((l) => l.includes("collection('resumes')"))) assert.doesNotMatch(line, /\.(set|update|delete|add)\(/, file);
        assert.doesNotMatch(code, /\.(insert|upsert|rpc)\(/, `${file} must not write to Supabase`);
        if (/\.from\('/.test(code)) assert.match(code, /createChatCatalogueReadOnlyFetch/, `${file} must use the read-only Supabase transport`);
    }
});
