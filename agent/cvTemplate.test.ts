import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from './agent';
import { agentTurnRequestSchema, type AgentBlock, type AgentEvent } from './contract';
import { CV_TEMPLATE_CATALOGUE, nextTemplate } from './tools/cvTemplate';

type Generate = NonNullable<Parameters<typeof runAgent>[3]>['generate'];

function scriptedModel(outputs: string[]) {
    const prompts: string[] = [];
    const systems: string[] = [];
    const generate: Generate = async (_op, request) => {
        systems.push((request.systemInstruction as { parts: Array<{ text: string }> }).parts[0].text);
        prompts.push((request.contents as Array<{ parts: Array<{ text: string }> }>)[0].parts[0].text);
        const text = outputs.shift();
        if (text === undefined) return { ok: false, status: 500, errorText: 'no more' };
        return {
            ok: true,
            body: { candidates: [{ content: { parts: [{ text }] } }] },
            diagnostics: { promptTokens: 100, outputTokens: 20, contentParts: 1, textParts: 1, thoughtParts: 0, functionCallParts: 0 },
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            attempts: 1,
            latencyMs: 1,
        };
    };
    return { generate, prompts, systems };
}

const call = (args: object = {}) => JSON.stringify({ toolCalls: [{ name: 'change_cv_template', args }] });
const answer = JSON.stringify({ answer: { text: 'Done: your CV now uses a new template.', ui: [], suggestions: [] } });

async function run(message: string, outputs: string[], tailoredCv?: { template: string }) {
    const model = scriptedModel(outputs);
    const events: AgentEvent[] = [];
    const result = await runAgent(
        { uid: 'u1', message, history: [], ...(tailoredCv ? { tailoredCv } : {}) },
        { send: (e) => events.push(e), closed: false },
        new AbortController().signal,
        { generate: model.generate },
    );
    const blocks = events.flatMap((e) => (e.type === 'block' ? [e.block] : []));
    return { ...model, result, blocks };
}

const templateBlock = (blocks: AgentBlock[]) => blocks.find((b): b is Extract<AgentBlock, { kind: 'cvTemplate' }> => b.kind === 'cvTemplate');

test('the template the model picks is sent to the browser; no CV picker even with no CV chosen', async () => {
    const { blocks, prompts, systems, result } = await run('change my CV template to something more modern', [call({ template: 'modern' }), answer], { template: 'classic' });
    assert.deepEqual(templateBlock(blocks), { kind: 'cvTemplate', template: 'modern', name: 'Modern' });
    assert.ok(!blocks.some((b) => b.kind === 'cvPicker'), '"my CV template" is not a question about their CV');
    assert.match(systems[0], /change_cv_template/);
    assert.match(prompts[0], /in the Classic template/);
    assert.match(prompts[1], /"changedTo":"Modern"/);
    assert.deepEqual(result.toolsUsed, ['change_cv_template']);
    // The template choice comes back with the conversation's saved blocks.
    assert.ok(result.blocks.some((b) => b.kind === 'cvTemplate'));
});

test('"a different one" with no preference moves to the next template', async () => {
    const { blocks } = await run('another one please', [call(), answer], { template: 'compact' });
    assert.equal(templateBlock(blocks)?.template, nextTemplate('compact').id);
    assert.equal(nextTemplate(CV_TEMPLATE_CATALOGUE.at(-1)!.id).id, 'classic', 'wraps round to the first');
    assert.equal(nextTemplate('unknown').id, 'classic');
});

test('asking for the template already in use changes nothing', async () => {
    const { blocks, prompts } = await run('use the classic one', [call({ template: 'classic' }), answer], { template: 'classic' });
    assert.equal(templateBlock(blocks), undefined);
    assert.match(prompts[1], /"alreadyUsing":"Classic"/);
});

test('without a tailored CV on screen the tool is not offered and cannot run', async () => {
    const { blocks, systems, prompts } = await run('change the template', [call({ template: 'modern' }), answer]);
    assert.doesNotMatch(systems[0], /- change_cv_template\(/);
    assert.match(systems[0], /type \/cv/);
    assert.equal(templateBlock(blocks), undefined);
    assert.match(prompts[1], /Unknown tool/);
});

test('an unknown template name is rejected so the model corrects it', async () => {
    const { blocks, prompts } = await run('make it pink', [call({ template: 'pink' }), call({ template: 'banner' }), answer], { template: 'classic' });
    assert.match(prompts[1], /Invalid arguments/);
    assert.equal(templateBlock(blocks)?.template, 'banner');
});

test('the turn request accepts the on-screen template and rejects anything else', () => {
    assert.ok(agentTurnRequestSchema.safeParse({ message: 'hi', tailoredCv: { template: 'modern' } }).success);
    assert.ok(!agentTurnRequestSchema.safeParse({ message: 'hi', tailoredCv: { template: '<script>' } }).success);});
