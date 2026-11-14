/**
 * Times a real "Give me jobs for my CV" turn twice (the second one shows the shared cache), with the made-up
 * evaluation CV: when the first cards appear, when they have the CV labels, and when the answer is done.
 * Reads only. Uses the real model and the database in .env (testing).
 *
 *   npx ts-node --transpile-only scripts/agent/timeJobSearch.ts
 *   npx ts-node --transpile-only scripts/agent/timeJobSearch.ts "Show me some full-stack jobs"   (another message)
 *   AGENT_FAST_RANK=1 npx ts-node --transpile-only scripts/agent/timeJobSearch.ts   (with the fast ranking)
 */
import 'dotenv/config';
import { runAgent } from '../../agent/agent';
import type { AgentEvent } from '../../agent/contract';
import { indexCv } from '../../agent/cv';
import { EVAL_CV } from '../../agent/eval/cases';
import { memoryStores } from '../../agent/testStores';
import { getJobsPortalRedis } from '../../jobs-portal/redisClient';

(async () => {
    const message = process.argv[2]?.trim() || 'Give me jobs for my CV';
    console.log('shared cache:', getJobsPortalRedis() ? 'Redis' : 'memory only', '| fast rank:', process.env.AGENT_FAST_RANK === '1' ? 'on' : 'off');
    const { index } = await indexCv('eval', EVAL_CV, { signal: AbortSignal.timeout(90_000), store: memoryStores().cvStore });
    for (const run of [1, 2]) {
        const t0 = Date.now();
        const marks: string[] = [];
        let firstCards = 0, finalCards = 0, firstText = 0, query = '';
        const result = await runAgent({ uid: 'eval', message, history: [], cv: index, deadlineAt: Date.now() + 50_000 }, {
            send: (e: AgentEvent) => {
                const t = (Date.now() - t0) / 1000;
                if (e.type === 'block' && e.block.kind === 'jobList') { query = e.block.card.query; if (e.block.card.checking) firstCards ||= t; else finalCards = t; }
                if (e.type === 'text' && !firstText) firstText = t;
                if (e.type === 'status' && e.state === 'running') marks.push(`${t.toFixed(1)}s ${e.label}`);
            }, closed: false,
        }, AbortSignal.timeout(55_000));
        const total = (Date.now() - t0) / 1000;
        console.log(`\nRun ${run}: AI calls ${result.calls.length}, tools ${result.toolsUsed.join(',')}`);
        console.log('  steps:', marks.join(' | '));
        console.log('  list:', query || '-', '| answer:', (result.answer?.text ?? '-').slice(0, 300));
        console.log(`  first cards ${firstCards ? firstCards.toFixed(1) + 's' : '-'} | cards with CV labels ${finalCards ? finalCards.toFixed(1) + 's' : '-'} | answer text starts ${firstText.toFixed(1)}s | done ${total.toFixed(1)}s`);
    }
})();
