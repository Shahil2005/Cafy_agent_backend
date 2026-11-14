/**
 * READ-ONLY check of the job embedding fill in the TESTING Supabase. Writes nothing anywhere.
 *
 *   npx ts-node --transpile-only scripts/agent/verifyJobPieces.ts            (all UK jobs)
 *   npx ts-node --transpile-only scripts/agent/verifyJobPieces.ts --source=ie
 *
 * For every job it checks:
 * - the embedded text is the job's CURRENT title + department + full description (content hash);
 * - the stored pieces are exactly the expected pieces (count and start/end offsets);
 * - together the pieces cover every character of that text (only blank space may fall between);
 * - every piece fits the model's 512-token window, so nothing was cut off when it was embedded.
 * It also prints a fingerprint of every column of every job row: run it before and after a fill;
 * the same fingerprint proves no job data was changed.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { MAX_PIECE_TOKENS, fitJobPieces, jobContentHash, jobText } from '../../agent/jobs/pieces';

const TESTING_REF = 'icsoljtmqwqibwpqhwyf';
const TABLES = { uk: 'jobs', ie: 'jobs_IR', pt: 'part_time_jobs_UK' } as const;
type Source = keyof typeof TABLES;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string | undefined]));
const source = (args.source ?? 'uk') as Source;

const url = process.env.SUPABASE_URL?.trim() ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function get<T>(path: string, attempt = 1): Promise<T> {
    try {
        const res = await fetch(`${url}/rest/v1/${path}`, { headers });
        if (res.ok) return (await res.json()) as T;
        if (attempt >= 6 || (res.status < 500 && res.status !== 429)) throw new Error(`GET ${path.split('?')[0]}: HTTP ${res.status}`);
    } catch (error) {
        if (attempt >= 6) throw error;
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
    return get<T>(path, attempt + 1);
}

type Tokenizer = (text: string, opts: object) => { input_ids: { size: number } };

async function loadTokenizer(): Promise<Tokenizer> {
    const { AutoTokenizer } = (await new Function('m', 'return import(m)')('@huggingface/transformers')) as {
        AutoTokenizer: { from_pretrained(model: string): Promise<Tokenizer> };
    };
    return AutoTokenizer.from_pretrained('Supabase/gte-small');
}

interface Piece { piece_no: number; start_at: number; end_at: number }

async function main(): Promise<void> {
    if (!url.includes(TESTING_REF)) throw new Error('SUPABASE_URL is not the testing project: refusing to run');
    if (!(source in TABLES)) throw new Error('--source must be uk, ie or pt');
    const table = TABLES[source];
    const tokenizer = await loadTokenizer();

    const state = new Map<number, { hash: string; pieces: number }>();
    for (let last = -1; ; ) {
        const rows = await get<Array<{ job_id: number; content_hash: string; pieces: number }>>(`agent_job_embed_state?select=job_id,content_hash,pieces&source=eq.${source}&job_id=gt.${last}&order=job_id.asc&limit=1000`);
        for (const r of rows) state.set(r.job_id, { hash: r.content_hash, pieces: r.pieces });
        if (rows.length < 1000) break;
        last = rows[rows.length - 1]!.job_id;
    }

    const fingerprint = createHash('sha256');
    const problems: Record<string, number[]> = { textChanged: [], wrongPieces: [], gap: [], overTokens: [] };
    const seen = new Set<number>();
    let jobs = 0, notYet = 0, ok = 0, pieces = 0, maxTokens = 0;
    const started = Date.now();

    for (let last = -1; ; ) {
        const page = await get<Array<Record<string, unknown> & { id: number; title: string; department: string | null; description: string | null }>>(
            `${encodeURIComponent(table)}?select=*&id=gt.${last}&order=id.asc&limit=300`,
        );
        if (!page.length) break;
        const ids = page.map((j) => j.id);
        const stored = new Map<number, Piece[]>();
        // Pieces for this page of jobs, read in small groups so no reply hits the row limit.
        for (let i = 0; i < ids.length; i += 100) {
            const group = ids.slice(i, i + 100);
            for (let from = 0; ; from += 1000) {
                const rows = await get<Array<Piece & { job_id: number }>>(
                    `agent_job_pieces?select=job_id,piece_no,start_at,end_at&source=eq.${source}&job_id=in.(${group.join(',')})&order=job_id.asc,piece_no.asc&offset=${from}&limit=1000`,
                );
                for (const r of rows) (stored.get(r.job_id) ?? stored.set(r.job_id, []).get(r.job_id)!).push(r);
                if (rows.length < 1000) break;
            }
        }

        for (const job of page) {
            jobs++;
            seen.add(job.id);
            fingerprint.update(JSON.stringify(Object.keys(job).sort().map((k) => [k, job[k]])));
            const s = state.get(job.id);
            if (!s) { notYet++; continue; }
            let good = true;
            if (s.hash !== jobContentHash(job)) { problems.textChanged!.push(job.id); good = false; }
            const countTokens = (t: string) => tokenizer(t, { add_special_tokens: true }).input_ids.size;
            const expected = fitJobPieces(job, countTokens);
            const got = stored.get(job.id) ?? [];
            if (got.length !== expected.length || s.pieces !== expected.length || expected.some((p, i) => got[i]?.start_at !== p.start || got[i]?.end_at !== p.end)) {
                problems.wrongPieces!.push(job.id);
                good = false;
            }
            const text = jobText(job);
            const covered = new Uint8Array(text.length);
            for (const p of got) covered.fill(1, p.start_at, Math.min(p.end_at, text.length));
            if ([...text].some((ch, i) => !covered[i] && ch.trim() !== '')) { problems.gap!.push(job.id); good = false; }
            for (const p of expected) {
                const n = countTokens(p.text);
                maxTokens = Math.max(maxTokens, n);
                if (n > MAX_PIECE_TOKENS) { problems.overTokens!.push(job.id); good = false; break; }
            }
            pieces += got.length;
            if (good) ok++;
        }
        last = page[page.length - 1]!.id;
        if (jobs % 3000 < 300) console.log(`  checked ${jobs.toLocaleString()} jobs…`);
    }

    console.log(`\n${table}: ${jobs.toLocaleString()} jobs`);
    console.log(`  fully embedded and correct: ${ok.toLocaleString()}  (${pieces.toLocaleString()} pieces, largest piece ${maxTokens} tokens of ${MAX_PIECE_TOKENS})`);
    console.log(`  not embedded yet:           ${notYet.toLocaleString()}`);
    for (const [name, list] of Object.entries(problems)) console.log(`  ${name.padEnd(27)} ${list.length}${list.length ? `  e.g. ${list.slice(0, 10).join(', ')}` : ''}`);
    const closed = [...state.keys()].filter((id) => !seen.has(id)).length;
    console.log(`  embedded but job closed:    ${closed}  (removed by the next full fill run)`);
    console.log(`  job data fingerprint:       ${fingerprint.digest('hex').slice(0, 24)}`);
    console.log(`  ${((Date.now() - started) / 60000).toFixed(1)} min`);
}

main().catch((error) => {
    console.error('Stopped:', (error as Error).message);
    process.exitCode = 1;
});
