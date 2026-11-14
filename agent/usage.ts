/** USD per 1M tokens (input, output). Check ai.google.dev / openai.com pricing before relying on totals. */
const PRICES: Array<{ match: RegExp; input: number; output: number }> = [
    { match: /gemini-2\.5-flash-lite/i, input: 0.1, output: 0.4 },
    { match: /gemini-2\.5-flash/i, input: 0.3, output: 2.5 },
    { match: /gpt-4o-mini/i, input: 0.15, output: 0.6 },
];

export function estimateUsd(model: string, promptTokens = 0, outputTokens = 0): number {
    const price = PRICES.find((p) => p.match.test(model));
    if (!price) return 0;
    return (promptTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export interface AgentAiCall {
    step: number;
    model: string;
    promptTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
}

/** Console-only cost log: no uid, no message text, no model output. */
export function logAgentUsage(calls: AgentAiCall[], outcome: string): void {
    const promptTokens = calls.reduce((n, c) => n + (c.promptTokens || 0), 0);
    const outputTokens = calls.reduce((n, c) => n + (c.outputTokens || 0), 0);
    const usd = calls.reduce((n, c) => n + estimateUsd(c.model, c.promptTokens, c.outputTokens), 0);
    console.info('[agent-usage]', {
        outcome,
        aiCalls: calls.length,
        models: [...new Set(calls.map((c) => c.model))],
        promptTokens,
        outputTokens,
        estUsd: Number(usd.toFixed(6)),
        latencyMs: calls.reduce((n, c) => n + (c.latencyMs || 0), 0),
    });
}

export interface UsageStore {
    hincrby(key: string, field: string, increment: number): Promise<unknown>;
    expire(key: string, seconds: number): Promise<unknown>;
    hgetall(key: string): Promise<Record<string, unknown> | null>;
}

const USAGE_KEEP_SECONDS = 120 * 24 * 60 * 60;

export function usageKey(day: string): string {
    return `agent:v1:usage:${day}`;
}

export function usageDay(now = new Date()): string {
    return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Adds one turn to today's totals (counts and cost only: no uid, no text), so spending per
 * outcome and per tool can be watched day by day. Never throws: monitoring must not fail a turn.
 */
export async function recordDailyUsage(
    calls: AgentAiCall[],
    outcome: string,
    tools: string[],
    store: UsageStore | null,
    now = new Date(),
): Promise<void> {
    if (!store) return;
    const key = usageKey(usageDay(now));
    const usdMicros = Math.round(calls.reduce((n, c) => n + estimateUsd(c.model, c.promptTokens, c.outputTokens), 0) * 1_000_000);
    const fields: Record<string, number> = {
        turns: 1,
        aiCalls: calls.length,
        promptTokens: calls.reduce((n, c) => n + (c.promptTokens || 0), 0),
        outputTokens: calls.reduce((n, c) => n + (c.outputTokens || 0), 0),
        usdMicros,
        [`outcome:${outcome.replace(/[^a-z_:-]/gi, '').slice(0, 40)}`]: 1,
        ...Object.fromEntries([...new Set(tools)].map((name) => [`tool:${name}`, 1])),
    };
    try {
        await Promise.all(Object.entries(fields).filter(([, n]) => n > 0).map(([field, n]) => store.hincrby(key, field, n)));
        await store.expire(key, USAGE_KEEP_SECONDS);
    } catch (error) {
        console.warn('[agent] usage store unavailable:', (error as Error)?.message);
    }
}

/** Daily totals for the last `days` days, newest first, with cost in USD. */
export async function readDailyUsage(store: UsageStore, days: number, now = new Date()): Promise<Array<{ day: string; usd: number } & Record<string, number | string>>> {
    const out: Array<{ day: string; usd: number } & Record<string, number | string>> = [];
    for (let i = 0; i < days; i++) {
        const day = usageDay(new Date(now.getTime() - i * 86_400_000));
        const raw = (await store.hgetall(usageKey(day))) ?? {};
        const totals = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v) || 0]));
        out.push({ day, ...totals, usd: Number(((totals.usdMicros ?? 0) / 1_000_000).toFixed(4)) });
    }
    return out;
}
