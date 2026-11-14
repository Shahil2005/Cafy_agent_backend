/**
 * SOC matching for Career Path, run inside Supabase so the vector search never leaves the
 * project network.
 *
 * WHY A CHARACTER BUDGET, NOT A CHUNK COUNT: Edge Functions cap CPU at 2s per request.
 * MEASURED on this project (not the docs' optimistic ~100-200ms figure): gte-small costs
 * ~495ms for a 2000-char chunk and ~212ms for a 1000-char chunk, i.e. ~0.25ms per character
 * and slightly superlinear in length. Four 2000-char chunks (~1.95s) plus RPC/JSON overhead
 * returns 546 WORKER_RESOURCE_LIMIT - verified. So the real constraint is total characters:
 * 4200 chars keeps CPU near 1.05s (~50% budget) regardless of how they are split, which also
 * lets the ingest script pack many short SOC descriptions into one call.
 *
 * Max-pooling is associative, so a caller merging several batch results by max gets exactly
 * the same ranking as one global pass - the per-batch fusion here loses nothing.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const MAX_CHUNKS_PER_CALL = 8;
/** ~0.25ms CPU per char measured; 4200 chars keeps one call near 50% of the 2s CPU cap. */
const MAX_TOTAL_CHARS = 4200;
const DEFAULT_MATCH_COUNT = 50;
/** gte-small truncates past 512 tokens; the caller sizes chunks to fit, this is a backstop. */
const MAX_CHUNK_CHARS = 2400;

interface SocRow {
    soc_code: string;
    title: string;
    category: string;
    similarity: number;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

Deno.serve(async (req) => {
    const secret = Deno.env.get('SOC_EMBED_SECRET');
    if (!secret || req.headers.get('x-internal-secret') !== secret) {
        return json({ error: 'FORBIDDEN' }, 403);
    }

    let payload: { chunks?: unknown; matchCount?: unknown; embedOnly?: unknown };
    try {
        payload = await req.json();
    } catch {
        return json({ error: 'INVALID_JSON' }, 400);
    }

    const chunks = payload.chunks;
    if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > MAX_CHUNKS_PER_CALL) {
        return json({ error: `chunks must be an array of 1..${MAX_CHUNKS_PER_CALL} strings` }, 400);
    }
    if (!chunks.every((c) => typeof c === 'string' && c.trim().length > 0)) {
        return json({ error: 'chunks must be non-empty strings' }, 400);
    }
    const totalChars = (chunks as string[]).reduce((n, c) => n + c.length, 0);
    if (totalChars > MAX_TOTAL_CHARS) {
        // Rejected rather than attempted: a 546 kills the invocation with no useful error,
        // whereas a 400 tells the caller exactly what to re-batch.
        return json({ error: 'CHUNKS_TOO_LARGE', totalChars, maxTotalChars: MAX_TOTAL_CHARS }, 400);
    }

    const matchCount =
        typeof payload.matchCount === 'number' && payload.matchCount > 0
            ? Math.min(Math.floor(payload.matchCount), 200)
            : DEFAULT_MATCH_COUNT;

    const startedAt = Date.now();
    const session = new Supabase.ai.Session('gte-small');

    // Embed first, so an `embedOnly` caller (the ingest script) never touches the DB.
    const embeddings: number[][] = [];
    try {
        for (const chunk of chunks as string[]) {
            const input = chunk.length > MAX_CHUNK_CHARS ? chunk.slice(0, MAX_CHUNK_CHARS) : chunk;
            const vec = (await session.run(input, { mean_pool: true, normalize: true })) as number[];
            embeddings.push(vec);
        }
    } catch (err) {
        console.error('[embed-match] embedding failed', err);
        return json({ error: 'EMBEDDING_FAILED', detail: String(err).slice(0, 300) }, 500);
    }

    if (payload.embedOnly === true) {
        return json({ embeddings, ms: Date.now() - startedAt });
    }

    const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        { auth: { persistSession: false, autoRefreshToken: false } }
    );

    // Keep each SOC code once, at its best score across this batch's chunks.
    const best = new Map<string, SocRow>();
    for (const embedding of embeddings) {
        const { data, error } = await supabase.rpc('match_soc_occupations_gte', {
            query_embedding: embedding,
            match_count: matchCount,
        });
        if (error) {
            console.error('[embed-match] rpc failed', error.message);
            return json({ error: 'VECTOR_SEARCH_FAILED', detail: error.message }, 500);
        }
        for (const row of (data ?? []) as SocRow[]) {
            const prev = best.get(row.soc_code);
            if (!prev || row.similarity > prev.similarity) best.set(row.soc_code, row);
        }
    }

    const matches = [...best.values()]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, matchCount);

    return json({ matches, chunks: chunks.length, ms: Date.now() - startedAt });
});
