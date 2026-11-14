/**
 * Fills agent_job_pieces in the TESTING Supabase with meaning vectors for every job advert.
 *
 *   npx ts-node --transpile-only scripts/agent/embedJobs.ts --dry-run          (count only)
 *   npx ts-node --transpile-only scripts/agent/embedJobs.ts --limit=50         (first 50 changed jobs)
 *   npx ts-node --transpile-only scripts/agent/embedJobs.ts                    (all UK jobs)
 *   npx ts-node --transpile-only scripts/agent/embedJobs.ts --source=ie        (Ireland / pt = part-time)
 *   npx ts-node --transpile-only scripts/agent/embedJobs.ts --local --shard=0/4 --threads=2  (local model, 1 of 4 parallel parts)
 *
 * - Reads jobs and writes ONLY the agent's own tables (agent_job_pieces, agent_job_embed_state).
 * - Refuses to run unless SUPABASE_URL is the testing project.
 * - Incremental: a job is embedded again only when its title/department/description changes;
 *   jobs that no longer exist have their pieces removed from the agent's tables (full runs only).
 * - Vectors come from the free gte-small edge function (embedOnly, stores nothing), or with --local
 *   from the same model on this machine (Supabase/gte-small, fp32): checked identical to the edge
 *   function (cosine 1.00000), so job vectors always match CV vectors. Faster, and no outages.
 * - Resumable: progress is saved per job, so a stopped run continues where it left off.
 */
import 'dotenv/config';
import { embedTexts } from '../../agent/cv/embed';
import { MAX_PIECE_TOKENS, fitJobPieces, jobContentHash, jobPieces } from '../../agent/jobs/pieces';

const TESTING_REF = 'fjcgtwrausyznshjkwyu';
const TABLES = { uk: 'jobs', ie: 'jobs_IR', pt: 'part_time_jobs_UK' } as const;
type Source = keyof typeof TABLES;
const READ_PAGE = 500;
const JOBS_PER_BATCH = 25;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string | undefined]));
const source = (args.source ?? 'uk') as Source;
const limit = args.limit ? Number(args.limit) : Infinity;
const dryRun = 'dry-run' in args;
const useLocal = 'local' in args;
/** --shard=k/n processes only jobs with id % n === k, so n copies can run in parallel. */
const [shardIndex, shardCount] = (args.shard ?? '0/1').split('/').map(Number) as [number, number];
const LOCAL_MODEL = 'Supabase/gte-small';
/** --threads=N limits each local copy. Several small copies do far more per thread than one large one. */
const threads = args.threads ? Number(args.threads) : 0;

type Extractor = ((texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>) & {
    tokenizer: (text: string) => { input_ids: { size: number } };
};
let localExtractor: Promise<Extractor> | null = null;

/** Same model as the edge function, full precision, so vectors are identical. */
function loadExtractor(): Promise<Extractor> {
    // A real dynamic import: the package is ESM-only and this script compiles to CommonJS.
    localExtractor ??= (new Function('m', 'return import(m)')('@huggingface/transformers') as Promise<{ pipeline: (task: string, model: string, opts: object) => Promise<Extractor> }>)
        .then(({ pipeline }) => pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'fp32', ...(threads ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {}) }));
    return localExtractor;
}

async function localEmbed(texts: string[]): Promise<number[][]> {
    const extractor = await loadExtractor();
    // Never store a vector of a piece the model only partly read.
    const tooLong = texts.find((t) => extractor.tokenizer(t).input_ids.size > MAX_PIECE_TOKENS);
    if (tooLong !== undefined) throw new Error(`A piece is over ${MAX_PIECE_TOKENS} tokens (starts "${tooLong.slice(0, 60)}"): nothing saved for this batch`);
    const out: number[][] = [];
    // One piece at a time: about 55% faster on a CPU than groups of 8, which waste work padding short pieces.
    for (const text of texts) out.push(...(await extractor([text], { pooling: 'mean', normalize: true })).tolist());
    return out;
}

const url = process.env.SUPABASE_URL?.trim() ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

async function rest(path: string, init: RequestInit = {}, attempt = 1): Promise<Response> {
    let res: Response;
    try {
        res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    } catch (error) {
        // Network drop ("fetch failed"): wait and try again instead of stopping the run.
        if (attempt >= 8) throw error;
        await new Promise((r) => setTimeout(r, Math.min(5_000 * 2 ** (attempt - 1), 120_000)));
        return rest(path, init, attempt + 1);
    }
    if (res.ok) return res;
    if (attempt < 4 && (res.status >= 500 || res.status === 429)) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        return rest(path, init, attempt + 1);
    }
    throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function loadState(): Promise<Map<number, string>> {
    const state = new Map<number, string>();
    for (let last = -1; ; ) {
        const rows = (await (await rest(`agent_job_embed_state?select=job_id,content_hash&source=eq.${source}&job_id=gt.${last}&order=job_id.asc&limit=1000`)).json()) as Array<{ job_id: number; content_hash: string }>;
        for (const r of rows) state.set(r.job_id, r.content_hash);
        if (rows.length < 1000) return state;
        last = rows[rows.length - 1]!.job_id;
    }
}

interface Job {
    id: number;
    title: string;
    department: string | null;
    description: string | null;
}

/** Vector as halfvec text; 5 decimals is far finer than half precision keeps. */
const vectorText = (v: number[]) => `[${v.map((x) => Number(x.toFixed(5))).join(',')}]`;

/** The embedding service has short outages (503 "service degraded"): wait and retry instead of stopping. */
async function embedWithRetry(texts: string[]): Promise<number[][]> {
    if (useLocal) return localEmbed(texts);
    for (let attempt = 1; ; attempt++) {
        try {
            return await embedTexts(texts);
        } catch (error) {
            if (attempt >= 8) throw error;
            const waitMs = Math.min(5_000 * 2 ** (attempt - 1), 120_000);
            console.warn(`  embedding service unavailable (attempt ${attempt}); retrying in ${waitMs / 1000}s`);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
}

async function embedBatch(jobs: Job[]): Promise<number> {
    const extractor = useLocal ? await loadExtractor() : null;
    const pieces = jobs.map((job) => ({ job, pieces: extractor ? fitJobPieces(job, (t) => extractor.tokenizer(t).input_ids.size) : jobPieces(job) }));
    const texts = pieces.flatMap((p) => p.pieces.map((x) => x.text));
    const vectors = await embedWithRetry(texts);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== 384)) throw new Error('Embedding count or size mismatch');
    let i = 0;
    const rows = pieces.flatMap(({ job, pieces: list }) =>
        // Pieces are cut by size only, so every piece has the same neutral section value.
        list.map((p) => ({ source, job_id: job.id, piece_no: p.pieceNo, section: 'other', start_at: p.start, end_at: p.end, embedding: vectorText(vectors[i++]!), updated_at: new Date().toISOString() })),
    );
    await rest('agent_job_pieces?on_conflict=source,job_id,piece_no', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    // A shorter new version of an advert leaves old extra pieces: remove them (agent table only).
    // One request per distinct piece count, sent together: per-job requests were the slowest part of a fill.
    const idsByCount = new Map<number, number[]>();
    for (const { job, pieces: list } of pieces) idsByCount.set(list.length, [...(idsByCount.get(list.length) ?? []), job.id]);
    await Promise.all([...idsByCount].map(([count, ids]) => rest(`agent_job_pieces?source=eq.${source}&job_id=in.(${ids.join(',')})&piece_no=gte.${count}`, { method: 'DELETE' })));
    await rest('agent_job_embed_state?on_conflict=source,job_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(pieces.map(({ job, pieces: list }) => ({ source, job_id: job.id, content_hash: jobContentHash(job), pieces: list.length, embedded_at: new Date().toISOString() }))),
    });
    return rows.length;
}

async function main(): Promise<void> {
    if (!url.includes(TESTING_REF)) throw new Error('SUPABASE_URL is not the testing project: refusing to run');
    if (!(source in TABLES)) throw new Error('--source must be uk, ie or pt');
    const table = TABLES[source];
    const state = await loadState();
    const seen = new Set<number>();
    let todo: Job[] = [];
    let changed = 0;
    let piecesWritten = 0;
    const started = Date.now();
    if (!(shardCount >= 1 && shardIndex >= 0 && shardIndex < shardCount)) throw new Error('--shard must look like 0/4');
    console.log(`${dryRun ? 'Counting' : 'Embedding'} ${table}${shardCount > 1 ? ` part ${shardIndex + 1}/${shardCount}` : ''}${useLocal ? ' with the local model' : ''} (already embedded: ${state.size.toLocaleString()})…`);

    for (let last = -1; changed < limit; ) {
        const page = (await (await rest(`${encodeURIComponent(table)}?select=id,title,department,description&id=gt.${last}&order=id.asc&limit=${READ_PAGE}`)).json()) as Job[];
        for (const job of page) {
            seen.add(job.id);
            if (job.id % shardCount !== shardIndex) continue;
            if (changed >= limit || state.get(job.id) === jobContentHash(job)) continue;
            changed++;
            todo.push(job);
            if (todo.length >= JOBS_PER_BATCH && !dryRun) {
                piecesWritten += await embedBatch(todo);
                todo = [];
                if (changed % 500 < JOBS_PER_BATCH) {
                    const perMin = (changed / ((Date.now() - started) / 60000)).toFixed(0);
                    console.log(`  ${changed.toLocaleString()} jobs, ${piecesWritten.toLocaleString()} pieces (${perMin} jobs/min)`);
                }
            }
        }
        if (page.length < READ_PAGE) break;
        last = page[page.length - 1]!.id;
    }
    if (todo.length && !dryRun) piecesWritten += await embedBatch(todo);

    // Closed jobs: remove their pieces from the agent's tables (only after a full, unlimited run).
    // Only a single full run knows every job; parallel parts and limited runs never remove anything.
    const gone = limit === Infinity && shardCount === 1 ? [...state.keys()].filter((id) => !seen.has(id)) : [];
    if (gone.length && !dryRun) {
        for (let i = 0; i < gone.length; i += 200) {
            const ids = gone.slice(i, i + 200).join(',');
            await rest(`agent_job_pieces?source=eq.${source}&job_id=in.(${ids})`, { method: 'DELETE' });
            await rest(`agent_job_embed_state?source=eq.${source}&job_id=in.(${ids})`, { method: 'DELETE' });
        }
    }
    console.log(`${dryRun ? 'Would embed' : 'Embedded'} ${changed.toLocaleString()} jobs (${piecesWritten.toLocaleString()} pieces); removed ${gone.length} closed jobs; ${((Date.now() - started) / 60000).toFixed(1)} min.`);
}

main().catch((error) => {
    console.error('Stopped:', (error as Error).message);
    process.exitCode = 1;
});
