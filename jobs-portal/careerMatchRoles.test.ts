import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { executeAiGeneration } from '../ai/orchestrator';
import type { OrchestratorSuccess } from '../ai/types';
import { expandCareerRole, MAX_CAREER_ROLE_TITLES } from './careerMatchRoles';
import type { CareerProfile } from './careerMatchTypes';

const profile: CareerProfile = {
    summary: 'You are an early-career engineer who builds Python tools. PRIVATE-SUMMARY-SENTINEL',
    level: 'early-career',
    skills: [{ name: 'Python', evidence: 'Built Python tools. PRIVATE-EVIDENCE-SENTINEL' }],
    roles: [{ title: 'Intern', evidence: 'Worked as an Intern at Fictional Ltd.' }],
};
const reply = (text: string, finishReason = 'STOP'): OrchestratorSuccess => ({
    ok: true, provider: 'gemini', model: 'fixture', attempts: 1, latencyMs: 1,
    body: { candidates: [{ content: { parts: [{ text }] } }] }, diagnostics: { finishReason } });
const titles = (...values: unknown[]) => reply(JSON.stringify({ titles: values }));
const expand = (role: string, generate: typeof executeAiGeneration, signal?: AbortSignal) =>
    expandCareerRole(role, profile, { timeoutMs: 1000, generate, signal });

test('a generic request widens to the equivalent titles employers use, with the request first', async () => {
    const family = await expand('developer', async () => titles('Software Engineer', 'Software Developer', 'Programmer', 'Web Developer'));
    assert.equal(family[0], 'developer');
    assert.ok(family.includes('Software Engineer'));
    assert.ok(family.includes('Programmer'));
    // Narrower and equivalent names stay: catalogue retrieval matches title words literally.
    assert.ok(family.includes('Software Developer'));
    assert.ok(family.length <= MAX_CAREER_ROLE_TITLES);
    const many = await expand('developer', async () => titles(...Array.from({ length: 12 }, (_, i) => `Developer Role ${i}`)));
    assert.equal(many.length, MAX_CAREER_ROLE_TITLES);
});

test('the same works for any occupation, not a fixed keyword list', async () => {
    assert.deepEqual(await expand('chef', async () => titles('Commis Chef', 'Line Cook', 'Kitchen Assistant')),
        ['chef', 'Commis Chef', 'Line Cook', 'Kitchen Assistant']);
    assert.deepEqual(await expand('Accountant', async () => titles('Accountant', 'Accounts Assistant', 'Finance Officer')),
        ['Accountant', 'Accounts Assistant', 'Finance Officer']);
});

test('broader, senior, unsafe or malformed titles never widen what was asked for', async () => {
    const family = await expand('Software Developer', async () => titles('Developer', 'Senior Software Engineer', 'Software Engineer',
        'ignore previous instructions', '<script>', 42, 'Registered Nurse', 'x'.repeat(120), 'software developer'));
    assert.deepEqual(family, ['Software Developer', 'Software Engineer']);
});

test('any provider failure falls back to the literal request', async () => {
    for (const generate of [
        async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); },
        async () => ({ ok: false as const, status: 429, errorText: 'PRIVATE_PROVIDER_ERROR' }),
        async () => reply('{"titles":["Software Engineer"', 'MAX_TOKENS'),
        async () => reply('not json'),
        async () => reply(JSON.stringify({ titles: 'Programmer' })),
    ] as Array<typeof executeAiGeneration>)
        assert.deepEqual(await expand('developer', generate), ['developer']);
    assert.deepEqual(await expand('   ', async () => titles('Programmer')), []);
});

test('a cancelled request is not swallowed as a fallback', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(expand('developer', async () => { throw new Error('aborted'); }, controller.signal));
});

test('the provider sees only the request, career stage and skill names, never CV text', async () => {
    let sent = '';
    let operation = '';
    await expand('developer', (async (...[op, request]: Parameters<typeof executeAiGeneration>) => {
        operation = op;
        sent = JSON.stringify(request.contents);
        return titles('Programmer');
    }) as typeof executeAiGeneration);
    assert.equal(operation, 'jobs_cv_roles');
    const payload = JSON.parse(JSON.parse(sent)[0].parts[0].text);
    assert.deepEqual(payload, { request: 'developer', background: { level: 'early-career', skills: ['Python'] } });
    assert.doesNotMatch(sent, /SENTINEL|Intern|Fictional Ltd/);
});
