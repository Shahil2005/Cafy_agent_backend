/**
 * Test scripts only. Saves each successful job ranking to a local file and reuses it when the exact
 * same search is asked again, so a retest does not use up the small testing database's disk budget.
 * A changed search (different words, CV or filters) has a different key and still goes to the database.
 * Off unless AGENT_RANK_REPLAY_DIR is set. Holds job ids and scores only; nothing is written to any database.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const RANK_PATH = '/rest/v1/rpc/agent_match_jobs';

export const replayCounts = { reused: 0, fromDatabase: 0 };

export function startRankReplay(dir: string | undefined = process.env.AGENT_RANK_REPLAY_DIR): void {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.endsWith(RANK_PATH) || typeof init?.body !== 'string') return realFetch(input, init);
        const file = join(dir, `${createHash('sha256').update(init.body).digest('hex')}.json`);
        if (existsSync(file)) {
            replayCounts.reused++;
            return new Response(readFileSync(file, 'utf8'), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        replayCounts.fromDatabase++;
        const response = await realFetch(input, init);
        if (response.ok) writeFileSync(file, await response.clone().text());
        return response;
    }) as typeof fetch;
}

startRankReplay();
