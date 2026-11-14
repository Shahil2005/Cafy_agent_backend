import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { executeAiGeneration } from '../ai/orchestrator';
import { cleanupDeletedCvs, stripCvCards, type CleanupStore } from './cleanup';
import { indexCv } from './cv';
import { extractCvProfile, NotCvError } from './cv/profile';
import { memoryStores } from './testStores';

function fakeModel(outputs: string[]): typeof executeAiGeneration {
    return async () => {
        const text = outputs.shift();
        if (text === undefined) return { ok: false, status: 500, errorText: 'none' };
        return { ok: true, body: { candidates: [{ content: { parts: [{ text }] } }] }, provider: 'gemini', model: 'gemini-2.5-flash-lite', attempts: 1, latencyMs: 1 };
    };
}

/** In-memory stand-in: records every write so tests can prove nothing else is touched. */
function fakeCleanupStore(init: {
    active: string[];
    names?: string[];
    cvs: Array<{ hash: string; name?: string; sourceCvIds?: string[] }>;
    conversations?: Array<{ id: string; cvHash: string; messages: any[] }>;
}) {
    const writes: string[] = [];
    const cvs = new Map(init.cvs.map((c) => [c.hash, { ...c }]));
    const conversations = new Map((init.conversations ?? []).map((c) => [c.id, { ...c }]));
    const store: CleanupStore = {
        activeResumeIds: async () => new Set(init.active),
        activeResumeNames: async () => new Set(init.names ?? []),
        listAgentCvs: async () => [...cvs.values()],
        deleteAgentCv: async (_u, hash) => { writes.push(`delete agentCvProfiles/${hash}`); cvs.delete(hash); },
        setAgentCvSources: async (_u, hash, ids) => { writes.push(`update agentCvProfiles/${hash}`); cvs.get(hash)!.sourceCvIds = ids; },
        conversationsUsingCvs: async (_u, hashes) => [...conversations.values()].filter((c) => hashes.includes(c.cvHash)),
        unlinkConversationCv: async (_u, id, messages) => { writes.push(`update agentConversations/${id}`); conversations.set(id, { ...conversations.get(id)!, cvHash: '', messages: messages as any[] }); },
    };
    return { store, writes, cvs, conversations };
}

test('deleting a resume removes only the agent copies whose resumes are all gone', async () => {
    const { store, writes, cvs } = fakeCleanupStore({
        active: ['keep1', 'profile'],
        cvs: [
            { hash: 'h-deleted', sourceCvIds: ['gone1'] },
            { hash: 'h-shared', sourceCvIds: ['gone2', 'keep1'] },
            { hash: 'h-profile', sourceCvIds: ['profile'] },
        ],
        conversations: [{ id: 'c1', cvHash: 'h-deleted', messages: [{ role: 'assistant', text: 'Here is your CV.', blocks: [{ kind: 'cvProfile', card: {} }, { kind: 'answerCard', pieces: [] }] }] }],
    });
    const result = await cleanupDeletedCvs('u1', store);
    assert.deepEqual(result, { removed: 1, unlinked: 1 });
    assert.deepEqual([...cvs.keys()].sort(), ['h-profile', 'h-shared']);
    assert.deepEqual(cvs.get('h-shared')!.sourceCvIds, ['keep1'], 'a CV still used by another resume is kept');
    // Every write is inside the agent's own folders.
    assert.ok(writes.every((w) => /^(delete|update) agent(CvProfiles|Conversations)\//.test(w)), writes.join(', '));
});

test('chat text stays; only the stored CV cards are removed', () => {
    const out = stripCvCards([{ text: 'Summary', blocks: [{ kind: 'cvProfile', card: {} as never }, { kind: 'answerCard', pieces: [] }] }]);
    assert.equal(out[0]!.text, 'Summary');
    assert.deepEqual(out[0]!.blocks!.map((b) => b.kind), ['answerCard']);
});

test('copies made before ids were recorded are kept only while a resume with the same name exists', async () => {
    const { store, cvs } = fakeCleanupStore({ active: ['x'], names: ['Current CV.pdf'], cvs: [{ hash: 'old-kept', name: 'Current CV.pdf' }, { hash: 'old-gone', name: 'Deleted CV.pdf' }] });
    await cleanupDeletedCvs('u1', store);
    assert.deepEqual([...cvs.keys()], ['old-kept']);
});

test('nothing to clean means no writes at all', async () => {
    const { store, writes } = fakeCleanupStore({ active: ['a'], cvs: [{ hash: 'h', sourceCvIds: ['a'] }] });
    assert.deepEqual(await cleanupDeletedCvs('u1', store), { removed: 0, unlinked: 0 });
    assert.equal(writes.length, 0);
});

const CV = 'EXPERIENCE\nData Analyst Intern, Northwind Retail, Jun 2023 - Aug 2023\nBuilt dashboards in Power BI.\nSKILLS\nPython, SQL';
const PROFILE = JSON.stringify({
    documentType: 'cv',
    headline: 'Data analyst',
    roles: [{ title: 'Data Analyst Intern', employer: 'Northwind Retail', evidence: 'Data Analyst Intern, Northwind Retail' }],
    skills: [{ name: 'Python', source: 'skills-list', evidence: 'Python, SQL' }],
});
const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);

test('the agent copy records which resume it came from, and adds new sources for the same CV', async () => {
    const stores = memoryStores();
    const opts = { signal: new AbortController().signal, store: stores.cvStore, embed, extract: (t: string, o: { signal: AbortSignal }) => extractCvProfile(t, { ...o, generate: fakeModel([PROFILE]) }) };
    const first = await indexCv('u1', { name: 'CV.pdf', text: CV, sourceId: 'resumeA' }, opts);
    assert.deepEqual(first.index.sourceCvIds, ['resumeA']);
    const second = await indexCv('u1', { name: 'Copy.pdf', text: CV, sourceId: 'resumeB' }, opts);
    assert.deepEqual(second.index.sourceCvIds, ['resumeA', 'resumeB']);
    assert.deepEqual(stores.cvs.get(first.index.hash).sourceCvIds, ['resumeA', 'resumeB']);
});

test('a file that is not a CV is detected and nothing is stored', async () => {
    const stores = memoryStores();
    const invoice = 'INVOICE 2041\nBill to: Example Ltd\nItem: Consulting services, 10 hours at £50\nTotal due: £500 within 30 days';
    await assert.rejects(
        indexCv('u1', { name: 'Invoice.pdf', text: invoice, sourceId: 'r1' }, {
            signal: new AbortController().signal,
            store: stores.cvStore,
            embed,
            extract: (t, o) => extractCvProfile(t, { ...o, generate: fakeModel([JSON.stringify({ documentType: 'not_cv', looksLike: 'invoice' })]) }),
        }),
        (error: any) => error.cause instanceof NotCvError && error.cause.looksLike === 'invoice',
    );
    assert.equal(stores.cvs.size, 0, 'nothing saved for a non-CV file');
});

test('a CV whose quotes fail verification is not mistaken for a non-CV file', async () => {
    const json = JSON.stringify({ documentType: 'cv', headline: 'h', roles: [{ title: 'Analyst', evidence: 'text that is not in the CV at all here' }] });
    const { profile } = await extractCvProfile(CV, { signal: new AbortController().signal, generate: fakeModel([json]) });
    assert.equal(profile.roles.length, 0);
});
