import '../env';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { callEmbedMatch, EMBEDDING_DIM } from '../ai/careerAnalysis/vectorSearch';
import { buildEmbeddingText, SocOccupationRecord } from './ingestSocOccupations';

/**
 * Builds the gte-small SOC index (uk_soc_occupations_gte) by embedding through the SAME
 * Supabase Edge Function the query path uses.
 *
 * WHY THIS EXISTS SEPARATELY from ingestSocOccupations.ts: that script embeds with the HF
 * Inference API into uk_soc_occupations (MiniLM). Both tables are vector(384), so a single
 * script writing "the" index would make it very easy to leave the two models mixed in one
 * table - which no dimension check can catch. Two scripts, two tables, one model each.
 *
 * Query and index vectors MUST come from the same model AND the same runtime. Embedding the
 * index here and querying via the edge function keeps them identical by construction.
 */

/**
 * Batched by TOTAL CHARACTERS, mirroring the query path: Edge Function CPU scales with
 * characters embedded (~0.25ms/char measured), so a fixed count is the wrong control.
 * SOC embedding texts here run 136..1455 chars (p50 812), so a fixed batch of 4 would send
 * up to 5820 chars and be rejected with CHUNKS_TOO_LARGE. Must stay <= MAX_TOTAL_CHARS
 * in supabase/functions/embed-match.
 */
const BATCH_CHAR_BUDGET = 4000;
const MAX_PER_BATCH = 8;

async function main() {
    const url = process.env.RESUME_SUPABASE_URL;
    const key = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error('Missing RESUME_SUPABASE_URL or RESUME_SUPABASE_SERVICE_ROLE_KEY');
    }
    if (!process.env.SOC_EMBED_FUNCTION_URL || !process.env.SOC_EMBED_SECRET) {
        throw new Error('Missing SOC_EMBED_FUNCTION_URL or SOC_EMBED_SECRET');
    }
    const supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const datasetPath = path.join(__dirname, '..', 'data', 'uk_soc_master.json');
    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
    const occupations: SocOccupationRecord[] = dataset.occupations;
    console.log(`Loaded ${occupations.length} occupations from ${datasetPath}`);
    console.log('Generating embeddings via Supabase Edge Function (gte-small)...');

    // Pack occupations into batches bounded by characters and count.
    const prepared = occupations.map((occ) => ({ occ, text: buildEmbeddingText(occ) }));
    const batches: { occ: SocOccupationRecord; text: string }[][] = [];
    let current: typeof prepared = [];
    let chars = 0;
    for (const item of prepared) {
        if (current.length > 0 && (chars + item.text.length > BATCH_CHAR_BUDGET || current.length >= MAX_PER_BATCH)) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(item);
        chars += item.text.length;
    }
    if (current.length > 0) batches.push(current);
    console.log(`Packed into ${batches.length} batches (<=${BATCH_CHAR_BUDGET} chars each)`);

    let processed = 0;
    for (const batch of batches) {
        const slice = batch.map((b) => b.occ);
        const chunks = batch.map((b) => b.text);

        const { embeddings } = await callEmbedMatch({ chunks, embedOnly: true });

        if (!Array.isArray(embeddings) || embeddings.length !== slice.length) {
            throw new Error(
                `embed-match returned ${embeddings?.length ?? 'none'} embeddings for ${slice.length} inputs`
            );
        }
        for (const vec of embeddings) {
            if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
                throw new Error(`Embedding has ${vec?.length} dims, expected ${EMBEDDING_DIM}`);
            }
            if (!vec.every((v) => Number.isFinite(v))) {
                throw new Error('Embedding contains non-finite values');
            }
        }

        // Same 4 columns as the MiniLM table: the RPC returns soc_code/title/category/
        // similarity and handler.ts re-derives salary/sponsorship from uk_soc_master.json.
        const rows = slice.map((occ, j) => ({
            soc_code: occ.code,
            title: occ.title,
            category: occ.category,
            embedding: embeddings[j],
        }));

        const { error } = await supabase
            .from('uk_soc_occupations_gte')
            .upsert(rows, { onConflict: 'soc_code' });
        if (error) throw new Error(`Upsert failed: ${error.message}`);

        processed += rows.length;
        console.log(`Upserted ${processed}/${occupations.length}`);
    }

    const { count, error: countError } = await supabase
        .from('uk_soc_occupations_gte')
        .select('soc_code', { count: 'exact', head: true });
    if (countError) throw new Error(`Verification count failed: ${countError.message}`);

    console.log(`Done. uk_soc_occupations_gte now holds ${count} rows.`);
    if (count !== occupations.length) {
        console.warn(
            `WARNING: expected ${occupations.length} rows but found ${count}. ` +
                'Do NOT switch CAREER_SOC_CHUNKED on until this matches.'
        );
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('gte ingestion failed:', err);
    process.exit(1);
});
