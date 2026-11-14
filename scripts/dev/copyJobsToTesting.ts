/**
 * Copies the jobs-side rows from LIVE into the TESTING Supabase project.
 *
 *   npx ts-node --transpile-only scripts/dev/copyJobsToTesting.ts           (practice run: counts only, writes nothing)
 *   npx ts-node --transpile-only scripts/dev/copyJobsToTesting.ts --apply   (copy)
 *
 * Safety:
 * - LIVE (SUPABASE_URL) is read through a guard that refuses anything but GET/HEAD.
 * - Writes go only to TEST_SUPABASE_URL, which must be the testing project, never the live one.
 * - Runs only after testing_jobs_setup.sql was applied (the cafy_testing_replica marker exists).
 * - job_reports is never copied (it holds users' emails). No other personal table is touched.
 * - Logs counts only, never row contents or keys.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCsv, TABLES } from './buildTestingSetup';

const TESTING_REF = 'fjcgtwrausyznshjkwyu';
const COPY = TABLES.filter((t) => t !== 'job_reports');
const PAGE: Record<string, number> = { jobs: 300, jobs_IR: 300, part_time_jobs_UK: 500 };
const DEFAULT_PAGE = 1000;

interface Target {
    url: string;
    key: string;
}

function readOnly(fetchImpl: typeof fetch): typeof fetch {
    return (input, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') throw new Error('Live is read-only in this script');
        return fetchImpl(input, init);
    };
}

const headers = (t: Target, extra: Record<string, string> = {}) => ({ apikey: t.key, Authorization: `Bearer ${t.key}`, ...extra });

async function withRetry<T>(work: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await work();
        } catch (error) {
            if (attempt >= 4) throw error;
            console.warn(`  retry ${attempt} for ${label}: ${(error as Error).message.slice(0, 120)}`);
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
}

async function count(t: Target, table: string, fetchImpl: typeof fetch): Promise<number> {
    const res = await fetchImpl(`${t.url}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, { method: 'HEAD', headers: headers(t, { Prefer: 'count=exact' }) });
    if (!res.ok) throw new Error(`count ${table}: HTTP ${res.status}`);
    return Number((res.headers.get('content-range') ?? '').split('/')[1] ?? NaN);
}

/** Columns to copy and the key to page by, from the live structure export. */
function tableShape(table: string, rows: string[][]): { columns: string[]; key: string } {
    const columns = rows
        .filter(([kind]) => kind === 'column')
        .map(([, , detail]) => JSON.parse(detail!) as { table: string; column: string; type: string; generated: string | null; position: number })
        .filter((c) => c.table === table && !c.generated && c.type !== 'tsvector')
        .sort((a, b) => a.position - b.position)
        .map((c) => c.column);
    const pk = rows.find(([kind, , detail]) => kind === 'constraint' && JSON.parse(detail!).table === table && JSON.parse(detail!).type === 'p');
    const key = pk ? /\((\w+)\)/.exec(JSON.parse(pk[2]!).def)?.[1] : undefined;
    if (!key || !columns.includes(key)) throw new Error(`No single-column primary key for ${table}`);
    return { columns, key };
}

async function copyTable(table: string, shape: { columns: string[]; key: string }, live: Target, test: Target, liveFetch: typeof fetch, apply: boolean): Promise<number> {
    const size = PAGE[table] ?? DEFAULT_PAGE;
    const select = shape.columns.map((c) => encodeURIComponent(c)).join(',');
    let last: string | number | null = null;
    let copied = 0;
    for (;;) {
        const after: string = last === null ? '' : `&${shape.key}=gt.${encodeURIComponent(String(last))}`;
        const page = await withRetry(async () => {
            const res = await liveFetch(`${live.url}/rest/v1/${encodeURIComponent(table)}?select=${select}&order=${shape.key}.asc&limit=${size}${after}`, { headers: headers(live) });
            if (!res.ok) throw new Error(`read ${table}: HTTP ${res.status}`);
            return (await res.json()) as Array<Record<string, unknown>>;
        }, `read ${table}`);
        if (!page.length) break;
        if (apply) {
            await withRetry(async () => {
                const res = await fetch(`${test.url}/rest/v1/${encodeURIComponent(table)}?on_conflict=${shape.key}`, {
                    method: 'POST',
                    headers: headers(test, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
                    body: JSON.stringify(page),
                });
                if (!res.ok) throw new Error(`write ${table}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
            }, `write ${table}`);
        }
        copied += page.length;
        last = page[page.length - 1]![shape.key] as string | number;
        if (copied % (size * 20) < size) console.log(`  ${table}: ${copied.toLocaleString()} rows`);
        if (page.length < size) break;
    }
    return copied;
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const live: Target = { url: process.env.SUPABASE_URL?.trim() ?? '', key: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '' };
    const test: Target = { url: process.env.TEST_SUPABASE_URL?.trim() ?? '', key: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '' };
    if (!live.url || !live.key || !test.url || !test.key) throw new Error('Set SUPABASE_URL/KEY (live) and TEST_SUPABASE_URL/KEY (testing) in .env');
    if (!test.url.includes(TESTING_REF)) throw new Error('TEST_SUPABASE_URL is not the testing project: refusing to write');
    if (live.url.includes(TESTING_REF) || new URL(live.url).host === new URL(test.url).host) throw new Error('Source and target are the same project: refusing');

    const liveFetch = readOnly(fetch);
    const marker = await fetch(`${test.url}/rest/v1/cafy_testing_replica?select=built_at&limit=1`, { headers: headers(test) });
    if (!marker.ok) throw new Error('Run scripts/dev/testing_jobs_setup.sql in the testing project first (marker table not found)');

    const rows = parseCsv(readFileSync(path.join(__dirname, 'live_jobs_schema.csv'), 'utf8'));
    console.log(apply ? 'Copying live -> testing (live is only read)…' : 'Practice run: counting only, nothing is written…');
    for (const table of COPY) {
        const shape = tableShape(table, rows);
        const [liveRows, testRowsBefore] = await Promise.all([count(live, table, liveFetch), count(test, table, fetch)]);
        console.log(`${table}: live ${liveRows.toLocaleString()} rows, testing now ${testRowsBefore.toLocaleString()}`);
        if (!apply) continue;
        const copied = await copyTable(table, shape, live, test, liveFetch, apply);
        console.log(`  done: ${copied.toLocaleString()} copied, testing now ${(await count(test, table, fetch)).toLocaleString()}`);
    }
    if (!apply) console.log('\nNothing was written. Run again with --apply to copy.');
}

main().catch((error) => {
    console.error('Stopped:', (error as Error).message);
    process.exitCode = 1;
});
