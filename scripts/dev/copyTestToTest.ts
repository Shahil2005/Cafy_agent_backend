/**
 * Copies the jobs-side rows from the OLD testing Supabase project into the NEW testing project.
 *
 *   npx ts-node --transpile-only scripts/dev/copyTestToTest.ts           (practice run: counts only, writes nothing)
 *   npx ts-node --transpile-only scripts/dev/copyTestToTest.ts --apply   (copy)
 *
 * Safety:
 * - OLD_TEST_SUPABASE_URL is read through a guard that refuses anything but GET/HEAD.
 * - Writes go only to TEST_SUPABASE_URL, which must be the new testing project.
 * - Runs only after testing_jobs_setup.sql was applied to the new project (cafy_testing_replica marker).
 * - job_reports is never copied (it holds users' emails).
 * - Logs counts only, never row contents or keys.
 */
import 'dotenv/config';
import { TABLES } from './buildTestingSetup';

const NEW_REF = 'fjcgtwrausyznshjkwyu';
const REST = [
    'agent_job_embed_state', 'agent_job_pieces', 'ats_import_audit', 'company_ats_config', 'customers', 'graduate_roles',
    'ireland_sponsored_companies', 'job_reports', 'reported_jobs', 'subscriptions', 'sync_run_summary',
    'user_applied_jobs', 'user_favorite_companies', 'user_preferences',
];
/** --rest copies the tables created by hand in the SQL editor; default copies the jobs tables. */
const ONLY = process.argv.find((a) => a.startsWith('--tables='))?.slice('--tables='.length).split(',').filter(Boolean);
const COPY = ONLY ?? (process.argv.includes('--rest') ? REST : TABLES.filter((t) => t !== 'job_reports'));
const PAGE: Record<string, number> = { jobs: 300, jobs_IR: 300, part_time_jobs_UK: 500, agent_job_pieces: 100 };
const DEFAULT_PAGE = 1000;

interface Target {
    url: string;
    key: string;
}

function readOnly(fetchImpl: typeof fetch): typeof fetch {
    return (input, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') throw new Error('Old testing project is read-only in this script');
        return fetchImpl(input, init);
    };
}

const headers = (t: Target, extra: Record<string, string> = {}) => ({ apikey: t.key, Authorization: `Bearer ${t.key}`, ...extra });

async function withRetry<T>(work: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await work();
        } catch (error) {
            if (attempt >= 6) throw error;
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

/** Columns to copy and the key to page by, read from the new project's own REST schema. */
async function tableShapes(t: Target): Promise<Record<string, { columns: string[]; keys: string[] }>> {
    const res = await fetch(`${t.url}/rest/v1/`, { headers: headers(t) });
    if (!res.ok) throw new Error(`schema: HTTP ${res.status}`);
    const defs = ((await res.json()) as { definitions?: Record<string, { properties: Record<string, { format?: string; description?: string }> }> }).definitions ?? {};
    const shapes: Record<string, { columns: string[]; keys: string[] }> = {};
    for (const table of COPY) {
        const props = defs[table]?.properties;
        if (!props) throw new Error(`Table ${table} not found in the new project`);
        const columns = Object.entries(props)
            .filter(([, v]) => v.format !== 'tsvector')
            .map(([name]) => name);
        const keys = Object.entries(props)
            .filter(([, v]) => (v.description ?? '').includes('Primary Key'))
            .map(([name]) => name);
        shapes[table] = { columns, keys };
    }
    return shapes;
}

async function copyTable(table: string, shape: { columns: string[]; keys: string[] }, from: Target, to: Target, fromFetch: typeof fetch, apply: boolean): Promise<number> {
    const size = PAGE[table] ?? DEFAULT_PAGE;
    const select = shape.columns.map((c) => encodeURIComponent(c)).join(',');
    // With a primary key (one or more columns): page after the last key tuple. No key: page by offset.
    const keyset = shape.keys.length > 0;
    const lit = (v: unknown) => encodeURIComponent(`"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    const after = (row: Record<string, unknown>) =>
        `&or=(${shape.keys
            .map((_, i) => {
                const eq = shape.keys.slice(0, i).map((k) => `${k}.eq.${lit(row[k])}`);
                const gt = `${shape.keys[i]}.gt.${lit(row[shape.keys[i]!])}`;
                return eq.length ? `and(${[...eq, gt].join(',')})` : gt;
            })
            .join(',')})`;
    const orderBy = (shape.keys.length ? shape.keys : shape.columns).map((c) => `${encodeURIComponent(c)}.asc`).join(',');
    if (!shape.keys.length) console.warn(`  ${table} has no primary key: re-running this table adds duplicate rows`);
    const conflict = shape.keys.length ? `?on_conflict=${shape.keys.map(encodeURIComponent).join(',')}` : '';
    let paging = '';
    if (keyset && apply) {
        // Resume after the highest key already in the new project (rows are upserted, so this is safe).
        const desc = shape.keys.map((c) => `${encodeURIComponent(c)}.desc`).join(',');
        const res = await fetch(`${to.url}/rest/v1/${encodeURIComponent(table)}?select=${shape.keys.map(encodeURIComponent).join(',')}&order=${desc}&limit=1`, { headers: headers(to) });
        const top = res.ok ? ((await res.json()) as Array<Record<string, unknown>>)[0] : undefined;
        if (top) {
            paging = after(top);
            console.log(`  ${table}: resuming after the last row already in the new project`);
        }
    }
    let copied = 0;
    for (;;) {
        const page = await withRetry(async () => {
            const res = await fromFetch(`${from.url}/rest/v1/${encodeURIComponent(table)}?select=${select}&order=${orderBy}&limit=${size}${keyset ? paging : `&offset=${copied}`}`, { headers: headers(from) });
            if (!res.ok) throw new Error(`read ${table}: HTTP ${res.status}`);
            return (await res.json()) as Array<Record<string, unknown>>;
        }, `read ${table}`);
        if (!page.length) break;
        if (apply) {
            await withRetry(async () => {
                const res = await fetch(`${to.url}/rest/v1/${encodeURIComponent(table)}${conflict}`, {
                    method: 'POST',
                    headers: headers(to, { 'Content-Type': 'application/json', Prefer: `${shape.keys.length ? 'resolution=merge-duplicates,' : ''}return=minimal` }),
                    body: JSON.stringify(page),
                });
                if (!res.ok) throw new Error(`write ${table}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
            }, `write ${table}`);
        }
        copied += page.length;
        if (keyset) paging = after(page[page.length - 1]!);
        if (copied % (size * 20) < size) console.log(`  ${table}: ${copied.toLocaleString()} rows`);
        if (page.length < size) break;
    }
    return copied;
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const from: Target = { url: process.env.OLD_TEST_SUPABASE_URL?.trim() ?? '', key: process.env.OLD_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '' };
    const to: Target = { url: process.env.TEST_SUPABASE_URL?.trim() ?? '', key: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '' };
    if (!from.url || !from.key || !to.url || !to.key) throw new Error('Set OLD_TEST_SUPABASE_URL/KEY (old) and TEST_SUPABASE_URL/KEY (new) in .env');
    if (!to.url.includes(NEW_REF)) throw new Error('TEST_SUPABASE_URL is not the new testing project: refusing to write');
    if (from.url.includes(NEW_REF) || new URL(from.url).host === new URL(to.url).host) throw new Error('Source and target are the same project: refusing');

    const fromFetch = readOnly(fetch);
    const marker = await fetch(`${to.url}/rest/v1/cafy_testing_replica?select=built_at&limit=1`, { headers: headers(to) });
    if (!marker.ok) throw new Error('Run scripts/dev/testing_jobs_setup.sql in the new testing project first (marker table not found)');

    const shapes = await tableShapes(to);
    console.log(apply ? 'Copying old testing -> new testing (old is only read)…' : 'Practice run: counting only, nothing is written…');
    for (const table of COPY) {
        const shape = shapes[table]!;
        const [oldRows, newRowsBefore] = await Promise.all([count(from, table, fromFetch), count(to, table, fetch)]);
        console.log(`${table}: old ${oldRows.toLocaleString()} rows, new now ${newRowsBefore.toLocaleString()}`);
        if (!apply) continue;
        const copied = await copyTable(table, shape, from, to, fromFetch, apply);
        console.log(`  done: ${copied.toLocaleString()} copied, new now ${(await count(to, table, fetch)).toLocaleString()}`);
    }
    if (!apply) console.log('\nNothing was written. Run again with --apply to copy.');
}

main().catch((error) => {
    console.error('Stopped:', (error as Error).message);
    process.exitCode = 1;
});
