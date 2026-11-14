import { createClient, SupabaseClient } from '@supabase/supabase-js';

const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
/** all-MiniLM-L6-v2 output width. The Supabase `embedding` column and the query vector
 *  MUST both be exactly this - a mismatch makes the RPC error or silently rank on garbage. */
export const EMBEDDING_DIM = 384;
const DEFAULT_MATCH_COUNT = 8;
/** MiniLM context is small; keep the query payload bounded for the inference API. */
const MAX_EMBED_CHARS = 8000;
/** HF serverless models cold-start and rate-limit; a query embedding is on the request path,
 *  so retry a few times before giving up rather than failing the whole analysis. */
const HF_MAX_ATTEMPTS = 4;
const HF_RETRY_BASE_MS = 1200;

export interface SocMatch {
    soc_code: string;
    title: string;
    category: string;
    skill_level: string | null;
    sponsorship: unknown;
    salary: unknown;
    similarity: number;
}

/**
 * Floor for the *best* SOC similarity in the shortlist. Below this the vector search has
 * effectively returned noise (see the DevOps-resume -> "Cooks / Carpenters" incident), and
 * shipping those to the AI just produces a confident-looking but meaningless report. When
 * the top match is under the floor we fail loud instead, so the caller can refund the slot
 * and tell the user we could not confidently match rather than inventing career paths.
 *
 * Tune with CAREER_SOC_MIN_TOP_SIMILARITY once the enriched embeddings are re-ingested and
 * real score distributions are known. Cosine similarity, range 0..1.
 */
const MIN_TOP_SIMILARITY = (() => {
    const raw = Number(process.env.CAREER_SOC_MIN_TOP_SIMILARITY);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.25;
})();

/** Raised when the vector search returns nothing usable (empty, or best match below the
 *  confidence floor). Not an infra failure - maps to HTTP 422, and the billing slot is refunded. */
export class LowConfidenceMatchError extends Error {
    readonly code = 'LOW_CONFIDENCE_MATCH' as const;
    readonly topSimilarity: number;

    constructor(topSimilarity: number) {
        super(
            'We could not confidently match this resume to UK occupations. This usually means the resume text was too sparse, unusually formatted, or scanned as an image. Try re-exporting it as a text-based PDF or DOCX.'
        );
        this.name = 'LowConfidenceMatchError';
        this.topSimilarity = topSimilarity;
    }
}

export function isLowConfidenceMatchError(error: unknown): error is LowConfidenceMatchError {
    return (
        error instanceof LowConfidenceMatchError ||
        (typeof error === 'object' &&
            error !== null &&
            (error as { code?: string }).code === 'LOW_CONFIDENCE_MATCH')
    );
}

let supabaseClient: SupabaseClient | null = null;
function getSupabase(): SupabaseClient {
    if (!supabaseClient) {
        const url = process.env.RESUME_SUPABASE_URL;
        const key = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
            throw new Error('Missing RESUME_SUPABASE_URL or RESUME_SUPABASE_SERVICE_ROLE_KEY');
        }
        supabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    }
    return supabaseClient;
}

function getHfToken(): string {
    const token =
        process.env.HF_TOKEN?.trim() ||
        process.env.HUGGINGFACE_HUB_TOKEN?.trim() ||
        process.env.HUGGING_FACE_HUB_TOKEN?.trim();
    if (!token) {
        throw new Error(
            'Missing HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) — required for SOC vector matching on Vercel'
        );
    }
    return token;
}

function l2Normalize(values: number[]): number[] {
    let sumSquares = 0;
    for (const v of values) sumSquares += v * v;
    const norm = Math.sqrt(sumSquares);
    if (!norm || !Number.isFinite(norm)) {
        throw new Error('Embedding vector had zero or non-finite norm');
    }
    return values.map((v) => v / norm);
}

/** True for `[number, number, ...]`. */
function isNumberVector(x: unknown): x is number[] {
    return Array.isArray(x) && x.length > 0 && typeof x[0] === 'number';
}

/**
 * Collapse whatever shape the HF feature-extraction pipeline returns for ONE input into a
 * single normalized 384-vector. Observed shapes vary by HF backend/region/model revision -
 * this is the #1 reason embeddings "work locally, break in prod":
 *   [384]                      already sentence-pooled
 *   [[384], [384], ...]        per-token, needs mean pooling
 *   [[[384], ...]]             the above wrapped in a batch dim of 1
 */
function toSentenceEmbedding(payload: unknown): number[] {
    let node: unknown = payload;

    // Unwrap a leading batch dimension of 1: [[...]] -> [...]
    while (
        Array.isArray(node) &&
        node.length === 1 &&
        Array.isArray(node[0]) &&
        !isNumberVector(node)
    ) {
        node = node[0];
    }

    if (isNumberVector(node)) {
        return l2Normalize(node);
    }

    if (Array.isArray(node) && node.length > 0 && isNumberVector(node[0])) {
        const rows = node as number[][];
        const dims = rows[0].length;
        const pooled = new Array<number>(dims).fill(0);
        for (const row of rows) {
            if (row.length !== dims) throw new Error('Ragged token embedding rows from HF');
            for (let i = 0; i < dims; i++) pooled[i] += row[i];
        }
        for (let i = 0; i < dims; i++) pooled[i] /= rows.length;
        return l2Normalize(pooled);
    }

    throw new Error(
        `HF embedding response had an unrecognized shape: ${JSON.stringify(payload).slice(0, 200)}`
    );
}

function assertEmbeddingDim(vec: number[]): number[] {
    if (vec.length !== EMBEDDING_DIM) {
        throw new Error(`Embedding has ${vec.length} dims, expected ${EMBEDDING_DIM}`);
    }
    if (!vec.every((v) => Number.isFinite(v))) {
        throw new Error('Embedding contains non-finite values');
    }
    return vec;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the HF feature-extraction pipeline for one or more inputs, with retry on the
 * transient failures that only really show up in production: 429 (rate limit), 5xx, and
 * 503 "model is currently loading" cold starts. Returns the raw parsed JSON.
 */
async function hfFeatureExtraction(inputs: string | string[]): Promise<unknown> {
    const token = getHfToken();
    const url = `https://router.huggingface.co/hf-inference/models/${EMBEDDING_MODEL}/pipeline/feature-extraction`;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= HF_MAX_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputs, options: { wait_for_model: true } }),
            });

            if (response.ok) return await response.json();

            const detail = (await response.text().catch(() => '')).slice(0, 300);
            const retryable = response.status === 429 || response.status >= 500;
            lastErr = new Error(`HF embedding failed (${response.status}): ${detail}`);
            if (!retryable || attempt === HF_MAX_ATTEMPTS) throw lastErr;
            console.warn(`[career-analysis] HF embed attempt ${attempt} got ${response.status}, retrying`);
        } catch (err) {
            lastErr = err;
            if (attempt === HF_MAX_ATTEMPTS) throw err;
            console.warn(`[career-analysis] HF embed attempt ${attempt} threw, retrying:`, (err as Error).message);
        }
        await sleep(HF_RETRY_BASE_MS * attempt);
    }
    throw lastErr;
}

/**
 * Embed a single string via the HF Inference API (the SOC index is built with this exact
 * same function - see scripts/ingestSocOccupations.ts - so query and index vectors can
 * never drift apart the way local-ONNX-ingest vs remote-API-query did).
 */
export async function embedText(text: string): Promise<number[]> {
    const input = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
    const data = await hfFeatureExtraction(input);
    const vec = assertEmbeddingDim(toSentenceEmbedding(data));
    console.log(`[career-analysis] Query embedding OK: dim=${vec.length} head=[${vec.slice(0, 3).map((v) => v.toFixed(4)).join(', ')}]`);
    return vec;
}

/** Batch variant for ingestion: one HTTP call for many inputs, so re-ingesting ~400 SOC
 *  rows doesn't fire 400 separate requests at the rate limiter. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const inputs = texts.map((t) => (t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t));
    const data = await hfFeatureExtraction(inputs);

    if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new Error(`HF batch returned ${Array.isArray(data) ? data.length : 'non-array'} results for ${inputs.length} inputs`);
    }
    return data.map((item) => assertEmbeddingDim(toSentenceEmbedding(item)));
}

async function matchSocOccupationsLegacy(
    resumeText: string,
    matchCount: number = DEFAULT_MATCH_COUNT
): Promise<SocMatch[]> {
    const queryEmbedding = await embedText(resumeText);
    const supabase = getSupabase();

    const { data, error } = await supabase.rpc('match_soc_occupations', {
        query_embedding: queryEmbedding,
        match_count: matchCount,
    });

    if (error) {
        throw new Error(`Vector search failed: ${error.message}`);
    }

    const matches = (data ?? []) as SocMatch[];

    // Score visibility: the shortlist was already logged downstream, but without the
    // similarity numbers a bad match (all scores ~0.1) looked identical to a good one.
    const topSimilarity = matches[0]?.similarity ?? 0;
    console.log(
        `[career-analysis] SOC vector search: ${matches.length} matches, ` +
            `top=${topSimilarity.toFixed(4)} floor=${MIN_TOP_SIMILARITY} ` +
            `(bottom=${(matches[matches.length - 1]?.similarity ?? 0).toFixed(4)})`
    );

    if (matches.length === 0 || topSimilarity < MIN_TOP_SIMILARITY) {
        throw new LowConfidenceMatchError(topSimilarity);
    }

    return matches;
}

/* ------------------------------------------------------------------------------------------
 * Chunked SOC matching (gte-small via Supabase Edge Function)
 *
 * THE BUG THIS FIXES: all-MiniLM-L6-v2 hard-truncates at 256 tokens, so only the first
 * ~200 words of a resume ever reached the query vector. On a 5-page CV that is the contact
 * block and the summary blurb - the least discriminative text in the document - and pages
 * 2-5 were discarded before matching. buildSocQueryText() in prompt.ts hoists the skills
 * section to the front to survive that truncation, which helps but still throws away most
 * of the resume.
 *
 * THE FIX: slice the whole resume into windows that each fit the model, embed every window,
 * search with each, then keep each SOC code at its BEST score across windows (max-pooling).
 *
 * WHY MAX AND NOT MEAN: cosine against a fixed target is linear in the query vector, so
 * averaging chunk vectors is *exactly* ranking by mean similarity across chunks. Mean
 * rewards breadth, and generic occupations ("administrative occupations n.e.c.") match every
 * chunk weakly while specific ones match one or two chunks strongly - so mean systematically
 * ranks vague occupations above precise ones. Max asks the right question instead: does any
 * part of this resume strongly look like this job? A resume legitimately spans several
 * occupations, and max surfaces all of them.
 * ---------------------------------------------------------------------------------------- */

/** 'off' = current MiniLM single-vector path (default). 'shadow' = serve legacy, compute and
 *  log chunked for comparison. 'on' = serve chunked. Flip with no redeploy. */
export type SocMatchMode = 'off' | 'shadow' | 'on';

export function getSocMatchMode(): SocMatchMode {
    const raw = process.env.CAREER_SOC_CHUNKED?.trim().toLowerCase();
    return raw === 'on' || raw === 'shadow' ? raw : 'off';
}

/** ~500 tokens - under gte-small's 512 window, so nothing is silently truncated. */
const CHUNK_CHARS = 2000;
/** Overlap so a skills list or job title split across a boundary still appears whole somewhere. */
const CHUNK_OVERLAP = 300;
/** Safety valve: 30 chunks covers ~50k chars (~12 pages). Overflow is logged, never silent. */
const MAX_CHUNKS = 30;
/** Below this a chunk is contact details / "References available on request" - it retrieves
 *  noise, and max-pooling has no sense of proportion, so one junk chunk can promote a code. */
const MIN_CHUNK_CHARS = 150;
/**
 * Batches are sized by TOTAL CHARACTERS, not chunk count, because Edge Function CPU scales
 * with characters embedded. MEASURED on this project: ~495ms CPU for a 2000-char chunk,
 * ~212ms for 1000 chars (~0.25ms/char). Four 2000-char chunks in one call returns
 * 546 WORKER_RESOURCE_LIMIT - verified, not theoretical. 4000 chars keeps a call near 50%
 * of the 2s cap, and must stay at or below MAX_TOTAL_CHARS in the edge function.
 */
const BATCH_CHAR_BUDGET = 4000;
/** Matches MAX_CHUNKS_PER_CALL in the edge function - the count cap only binds for short
 *  inputs (e.g. SOC descriptions during ingest); resume chunks hit the char budget first. */
const MAX_CHUNKS_PER_BATCH = 8;
/** Bounds concurrent edge invocations (and therefore DB clients) per analysis. Micro compute
 *  allows 200 pooler clients total, shared with every other feature in the product. Five lets
 *  a typical 5-page resume (10 chunks -> 5 batches) finish in a single wave. */
const MAX_INFLIGHT_BATCHES = 5;

const CHUNK_STEP = CHUNK_CHARS - CHUNK_OVERLAP;
if (CHUNK_STEP <= 0) {
    // Would loop forever rather than error - assert at module load, not per request.
    throw new Error('CHUNK_OVERLAP must be smaller than CHUNK_CHARS');
}

/** Max chars the chunker can cover before MAX_CHUNKS truncates. */
const MAX_COVERED_CHARS = CHUNK_CHARS + (MAX_CHUNKS - 1) * CHUNK_STEP;

/**
 * Slice text into overlapping windows that each fit the embedding model.
 *
 * Uses \p{L} (any script) rather than [a-z]: a CV in Cyrillic, Arabic or CJK would otherwise
 * filter to zero chunks and surface as a confusing LOW_CONFIDENCE_MATCH.
 */
export function chunkForEmbedding(text: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK_STEP) {
        const piece = text.slice(i, i + CHUNK_CHARS).trim();
        if (piece.length >= MIN_CHUNK_CHARS && /\p{L}{4}/u.test(piece)) chunks.push(piece);
    }
    // A short or unusually formatted resume can filter to nothing. Embedding the whole thing
    // is strictly better than failing, and handler.ts already rejected text under 50 chars.
    if (chunks.length === 0) {
        const whole = text.trim();
        if (whole.length > 0) chunks.push(whole.slice(0, CHUNK_CHARS));
    }
    return chunks;
}

function getEmbedFunctionUrl(): string {
    const url = process.env.SOC_EMBED_FUNCTION_URL?.trim();
    if (!url) throw new Error('Missing SOC_EMBED_FUNCTION_URL (Supabase embed-match function)');
    return url;
}

function getEmbedSecret(): string {
    const secret = process.env.SOC_EMBED_SECRET?.trim();
    if (!secret) throw new Error('Missing SOC_EMBED_SECRET (shared secret for embed-match)');
    return secret;
}

const EDGE_MAX_ATTEMPTS = 3;
const EDGE_RETRY_BASE_MS = 400;

interface EmbedMatchResponse {
    matches?: SocMatch[];
    embeddings?: number[][];
    error?: string;
    detail?: string;
    ms?: number;
}

/**
 * POST one batch of chunks to the embed-match edge function.
 *
 * Retries 429/5xx - notably 546 WORKER_RESOURCE_LIMIT, which is what a batch that overran
 * the 2s CPU budget looks like. A 4xx other than 429 is our bug, so it fails fast.
 */
export async function callEmbedMatch(
    body: { chunks: string[]; matchCount?: number; embedOnly?: boolean }
): Promise<EmbedMatchResponse> {
    const url = getEmbedFunctionUrl();
    const secret = getEmbedSecret();
    let lastErr: unknown;

    for (let attempt = 1; attempt <= EDGE_MAX_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret },
                body: JSON.stringify(body),
            });

            if (response.ok) return (await response.json()) as EmbedMatchResponse;

            const detail = (await response.text().catch(() => '')).slice(0, 300);
            lastErr = new Error(`embed-match failed (${response.status}): ${detail}`);
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable || attempt === EDGE_MAX_ATTEMPTS) throw lastErr;
            console.warn(`[career-analysis] embed-match attempt ${attempt} got ${response.status}, retrying`);
        } catch (err) {
            lastErr = err;
            if (attempt === EDGE_MAX_ATTEMPTS) throw err;
            console.warn(`[career-analysis] embed-match attempt ${attempt} threw, retrying:`, (err as Error).message);
        }
        await sleep(EDGE_RETRY_BASE_MS * attempt);
    }
    throw lastErr;
}

/** Run `worker` over `items` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            try {
                results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    });

    await Promise.all(runners);
    return results;
}

export interface ChunkedMatchResult {
    matches: SocMatch[];
    chunkCount: number;
    batchesOk: number;
    batchesFailed: number;
    coveredChars: number;
    totalChars: number;
}

/**
 * Pack chunks into batches bounded by both total characters and count, so no single call can
 * exceed the edge function's CPU budget. A chunk longer than the budget on its own still gets
 * its own batch - the function truncates it rather than failing.
 */
function batchByCharBudget(chunks: string[]): string[][] {
    const batches: string[][] = [];
    let current: string[] = [];
    let chars = 0;

    for (const chunk of chunks) {
        const wouldExceed = chars + chunk.length > BATCH_CHAR_BUDGET || current.length >= MAX_CHUNKS_PER_BATCH;
        if (current.length > 0 && wouldExceed) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(chunk);
        chars += chunk.length;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/**
 * Chunked match WITHOUT the confidence floor applied - the caller decides, so shadow mode can
 * observe scores that would have been rejected.
 */
export async function matchSocOccupationsChunked(
    resumeText: string,
    matchCount: number = DEFAULT_MATCH_COUNT
): Promise<ChunkedMatchResult> {
    const chunks = chunkForEmbedding(resumeText);
    const coveredChars = Math.min(resumeText.length, MAX_COVERED_CHARS);
    if (coveredChars < resumeText.length) {
        console.warn(
            `[career-analysis] Resume truncated at embedding: ${coveredChars}/${resumeText.length} chars ` +
                `(${MAX_CHUNKS}-chunk cap). Raise MAX_CHUNKS.`
        );
    }

    const batches = batchByCharBudget(chunks);

    // allSettled, not all: losing one batch of four chunks still leaves most of the resume to
    // rank on. Promise.all would multiply the transient-failure rate by the batch count.
    const settled = await mapWithConcurrency(batches, MAX_INFLIGHT_BATCHES, (batch) =>
        callEmbedMatch({ chunks: batch, matchCount })
    );

    const best = new Map<string, SocMatch>();
    let batchesOk = 0;
    let batchesFailed = 0;

    for (const result of settled) {
        if (result.status !== 'fulfilled') {
            batchesFailed++;
            console.warn('[career-analysis] chunk batch failed:', (result.reason as Error)?.message);
            continue;
        }
        batchesOk++;
        for (const row of result.value.matches ?? []) {
            const prev = best.get(row.soc_code);
            if (!prev || row.similarity > prev.similarity) best.set(row.soc_code, row);
        }
    }

    if (batchesOk === 0) {
        throw new Error(`All ${batches.length} embedding batches failed`);
    }

    // Merging per-batch maxima by max is exact: max(max(a), max(b)) === max over a and b.
    const matches = [...best.values()]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, matchCount);

    console.log(
        `[career-analysis] SOC chunked search: chunks=${chunks.length} ` +
            `batches=${batchesOk}ok/${batchesFailed}fail chars=${coveredChars}/${resumeText.length} ` +
            `unique=${best.size} returned=${matches.length} ` +
            `top=${(matches[0]?.similarity ?? 0).toFixed(4)}`
    );

    return {
        matches,
        chunkCount: chunks.length,
        batchesOk,
        batchesFailed,
        coveredChars,
        totalChars: resumeText.length,
    };
}

/** Overlap of the two shortlists, for shadow-mode comparison. */
function shortlistOverlap(a: SocMatch[], b: SocMatch[]): number {
    const codes = new Set(a.map((m) => m.soc_code));
    return b.reduce((n, m) => n + (codes.has(m.soc_code) ? 1 : 0), 0);
}

/**
 * Entry point. Shape is unchanged from the original single-vector implementation, so
 * prompt.ts / handler.ts / billing are untouched by the mode.
 */
export async function matchSocOccupations(
    resumeText: string,
    matchCount: number = DEFAULT_MATCH_COUNT
): Promise<SocMatch[]> {
    const mode = getSocMatchMode();

    if (mode === 'off') {
        return matchSocOccupationsLegacy(resumeText, matchCount);
    }

    if (mode === 'on') {
        const { matches } = await matchSocOccupationsChunked(resumeText, matchCount);
        const topSimilarity = matches[0]?.similarity ?? 0;
        console.log(
            `[career-analysis] SOC vector search (chunked): ${matches.length} matches, ` +
                `top=${topSimilarity.toFixed(4)} floor=${MIN_TOP_SIMILARITY}`
        );
        if (matches.length === 0 || topSimilarity < MIN_TOP_SIMILARITY) {
            throw new LowConfidenceMatchError(topSimilarity);
        }
        return matches;
    }

    // shadow: users get today's result; the chunked path runs in parallel purely to log a
    // comparison on real resumes. Its failures - including a low score that WOULD have been
    // rejected - must never affect the response, so nothing here throws.
    const [legacy, chunked] = await Promise.allSettled([
        matchSocOccupationsLegacy(resumeText, matchCount),
        matchSocOccupationsChunked(resumeText, matchCount),
    ]);

    if (chunked.status === 'fulfilled') {
        const legacyMatches = legacy.status === 'fulfilled' ? legacy.value : [];
        const c = chunked.value;
        console.log(
            `[career-analysis] SHADOW ` +
                `legacyTop=${(legacyMatches[0]?.similarity ?? 0).toFixed(4)} ` +
                `chunkedTop=${(c.matches[0]?.similarity ?? 0).toFixed(4)} ` +
                `overlap=${shortlistOverlap(legacyMatches, c.matches)}/${c.matches.length} ` +
                `chunks=${c.chunkCount} chars=${c.coveredChars}/${c.totalChars} ` +
                `legacyStatus=${legacy.status} ` +
                `legacyCodes=[${legacyMatches.slice(0, 8).map((m) => m.soc_code).join(',')}] ` +
                `chunkedCodes=[${c.matches.slice(0, 8).map((m) => m.soc_code).join(',')}]`
        );
    } else {
        console.warn('[career-analysis] SHADOW chunked path failed:', (chunked.reason as Error)?.message);
    }

    if (legacy.status === 'rejected') throw legacy.reason;
    return legacy.value;
}
