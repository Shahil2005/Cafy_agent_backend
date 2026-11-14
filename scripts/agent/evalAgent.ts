/**
 * Runs the chat agent's quality test set (agent/eval/cases.ts) against the REAL model and tools.
 *
 *   npx ts-node --transpile-only scripts/agent/evalAgent.ts               (all cases)
 *   npx ts-node --transpile-only scripts/agent/evalAgent.ts --only=gov    (ids starting "gov")
 *
 * - Uses a made-up CV and in-memory stores: nothing is saved to Firebase, Supabase or Redis.
 *   Tools only read (sponsor register file, SOC data, GOV.UK files, read-only company lookup).
 * - Prints one line per case and the total cost; exits with code 1 if any case fails, so a
 *   change that makes an answer worse is caught before release. About $0.03 per full run.
 */
import 'dotenv/config';
import './rankReplay';
import { runAgent } from '../../agent/agent';
import type { AgentBlock, AgentEvent } from '../../agent/contract';
import { indexCv, type CvIndex } from '../../agent/cv';
import { EVAL_CASES, EVAL_CV, type EvalCase } from '../../agent/eval/cases';
import { gateMessage } from '../../agent/gate';
import { memoryStores } from '../../agent/testStores';
import { estimateUsd, type AgentAiCall } from '../../agent/usage';

/** --parallel=1 for job cases on the small free testing database, which is slow with several searches at once. */
const PARALLEL = Number(process.argv.find((a) => a.startsWith('--parallel='))?.slice(11)) || 4;

interface Outcome {
    id: string;
    failures: string[];
    usd: number;
    ms: number;
    answer: string;
}

function check(c: EvalCase, run: { blocked: boolean; text: string; blocks: AgentBlock[]; tools: string[]; failure?: string }): string[] {
    const e = c.expect;
    const failures: string[] = [];
    if (run.blocked && e.allowBlocked) return failures;
    if (e.blocked !== undefined && e.blocked !== run.blocked) failures.push(e.blocked ? 'should be blocked by the safety gate' : 'was blocked by the safety gate');
    if (e.blocked) return failures;
    if (run.blocked) return ['was blocked by the safety gate'];
    if (!run.text) failures.push(`no answer (${run.failure ?? 'unknown'})`);
    const kinds = new Set(run.blocks.map((b) => b.kind));
    const output = `${run.text}\n${JSON.stringify(run.blocks.filter((b) => b.kind === 'answerCard'))}`;
    for (const tool of e.tools ?? []) if (!run.tools.includes(tool)) failures.push(`tool ${tool} not used`);
    if (e.anyTool && !e.anyTool.some((t) => run.tools.includes(t))) failures.push(`none of ${e.anyTool.join('/')} used`);
    for (const tool of e.noTools ?? []) if (run.tools.includes(tool)) failures.push(`tool ${tool} should not run`);
    for (const kind of e.blocks ?? []) if (!kinds.has(kind)) failures.push(`card ${kind} missing`);
    for (const kind of e.noBlocks ?? []) if (kinds.has(kind)) failures.push(`card ${kind} should not show`);
    for (const pattern of e.text ?? []) if (!pattern.test(output)) failures.push(`missing ${pattern}`);
    for (const pattern of e.notText ?? []) {
        const hit = pattern.exec(output);
        if (hit) failures.push(`must not say ${pattern}: "…${output.slice(Math.max(0, hit.index - 60), hit.index + hit[0].length + 40).replace(/\s+/g, ' ')}…"`);
    }
    if (e.maxChars && run.text.length > e.maxChars) failures.push(`too long (${run.text.length} > ${e.maxChars})`);
    return failures;
}

async function runCase(c: EvalCase, cv: CvIndex): Promise<Outcome> {
    const started = Date.now();
    const gate = gateMessage(c.message);
    if (!gate.allowed) return { id: c.id, failures: check(c, { blocked: true, text: '', blocks: [], tools: [] }), usd: 0, ms: 0, answer: '(blocked)' };
    const events: AgentEvent[] = [];
    const signal = AbortSignal.timeout(50_000);
    const run = await runAgent(
        { uid: 'eval', message: c.message, history: [], cv: c.cv ? cv : null, deadlineAt: Date.now() + 50_000, caution: gate.caution },
        { send: (e) => events.push(e), closed: false },
        signal,
    );
    const text = run.answer?.text ?? '';
    // Rest between searches: each one scans every job piece, and the small testing database runs out of disk speed.
    if (run.toolsUsed.includes('search_jobs')) await new Promise((resolve) => setTimeout(resolve, 20_000));
    return {
        id: c.id,
        failures: check(c, { blocked: false, text, blocks: run.blocks, tools: run.toolsUsed, failure: run.failure }),
        usd: run.calls.reduce((n, call) => n + estimateUsd(call.model, call.promptTokens, call.outputTokens), 0),
        ms: Date.now() - started,
        answer: text,
    };
}

async function main(): Promise<void> {
    const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
    const cases = EVAL_CASES.filter((c) => !only || c.id.startsWith(only));
    console.log(`Indexing the made-up evaluation CV, then running ${cases.length} cases…`);
    const indexed = await indexCv('eval', EVAL_CV, { signal: AbortSignal.timeout(60_000), store: memoryStores().cvStore });
    const setupUsd = indexed.calls.reduce((n: number, call: AgentAiCall) => n + estimateUsd(call.model, call.promptTokens, call.outputTokens), 0);

    const results: Outcome[] = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: PARALLEL }, async () => {
            while (next < cases.length) {
                const c = cases[next++]!;
                const outcome = await runCase(c, indexed.index).catch((error: Error) => ({ id: c.id, failures: [`crashed: ${error.name}`], usd: 0, ms: 0, answer: '' }));
                results.push(outcome);
                console.log(`${outcome.failures.length ? 'FAIL' : 'pass'}  ${c.id.padEnd(8)} ${String(outcome.ms).padStart(6)}ms  ${c.message.slice(0, 60)}`);
                for (const f of outcome.failures) console.log(`        - ${f}`);
                if (outcome.failures.length) console.log(`        answer: ${outcome.answer.slice(0, 300).replace(/\s+/g, ' ')}`);
            }
        }),
    );
    const failed = results.filter((r) => r.failures.length);
    const usd = setupUsd + results.reduce((n, r) => n + r.usd, 0);
    console.log(`\n${results.length - failed.length}/${results.length} passed · cost about $${usd.toFixed(4)}`);
    if (failed.length) {
        console.log(`Failed: ${failed.map((r) => r.id).sort().join(', ')}`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error('Evaluation could not run:', (error as Error)?.name);
    process.exitCode = 1;
});
