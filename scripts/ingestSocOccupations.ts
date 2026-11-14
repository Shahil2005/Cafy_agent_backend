import '../env';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { embedTexts } from '../ai/careerAnalysis/vectorSearch';

// Embed via the SAME HF Inference API the query path uses (embedTexts). Previously this
// script embedded locally with Xenova/onnxruntime while production queried the remote API -
// two different MiniLM implementations, so index and query vectors sat in slightly different
// spaces and cosine similarity was unreliable in prod ("works locally, breaks in prod").
const BATCH_SIZE = 24;

export interface SocOccupationRecord {
    code: string;
    title: string;
    category: string;
    relatedJobTitles: string[];
    expandedJobTitles: string[];
    skillLevel: string | null;
    sponsorship: unknown;
    salary: unknown;
}

/** Cap on expandedJobTitles fed into the embedding: some SOC groups list 1000+ of them,
 *  which would blow past MiniLM's ~256-token window and drown the distinctive terms. The
 *  curated relatedJobTitles list (max ~21) is always kept in full ahead of these. */
const MAX_EXPANDED_TITLES_IN_EMBEDDING = 40;

function dedupePreserveOrder(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of values) {
        const value = raw.trim();
        if (!value) continue;
        const key = value.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}

// The embedding is what the resume is actually matched against at query time, so it has to
// carry the occupation's real-world vocabulary - not just the abstract ONS group title.
// The old version embedded only `"<title>. Category: <category>"`, so a group like
// "Information technology professionals nec" had none of the words a real resume uses
// ("DevOps", "AWS", "software", ...) anywhere in its vector, and matching collapsed to noise.
// relatedJobTitles / expandedJobTitles hold exactly those concrete job-title synonyms.
export function buildEmbeddingText(occ: SocOccupationRecord): string {
    const titleKey = occ.title.trim().toLowerCase().replace(/[.\s]+$/, '');
    const isNoiseAlias = (t: string) => {
        const k = t.trim().toLowerCase().replace(/[.\s]+$/, '');
        return k === titleKey || k.endsWith('not elsewhere classified');
    };

    const related = dedupePreserveOrder(occ.relatedJobTitles || []).filter((t) => !isNoiseAlias(t));
    const expanded = dedupePreserveOrder(occ.expandedJobTitles || [])
        .filter((t) => !isNoiseAlias(t))
        .filter((t) => !related.some((r) => r.toLowerCase() === t.toLowerCase()))
        .slice(0, MAX_EXPANDED_TITLES_IN_EMBEDDING);

    const parts = [`${occ.title.replace(/\s*\.\s*$/, '')}.`];
    if (related.length) parts.push(`Also known as: ${related.join(', ')}.`);
    if (expanded.length) parts.push(`Example job titles: ${expanded.join(', ')}.`);
    parts.push(`Category: ${occ.category}.`);
    if (occ.skillLevel) parts.push(`Skill level: ${occ.skillLevel}.`);

    return parts.join(' ');
}

async function main() {
    const url = process.env.RESUME_SUPABASE_URL;
    const key = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error('Missing RESUME_SUPABASE_URL or RESUME_SUPABASE_SERVICE_ROLE_KEY');
    }
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

    const datasetPath = path.join(__dirname, '..', 'data', 'uk_soc_master.json');
    const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
    const occupations: SocOccupationRecord[] = dataset.occupations;
    console.log(`Loaded ${occupations.length} occupations from ${datasetPath}`);

    console.log('Generating embeddings via HF Inference API (same path as query)...');

    let processed = 0;
    for (let i = 0; i < occupations.length; i += BATCH_SIZE) {
        const slice = occupations.slice(i, i + BATCH_SIZE);
        const embeddings = await embedTexts(slice.map(buildEmbeddingText));

        // The live table only has these 4 columns (+ an auto `id`); the RPC only returns
        // soc_code/title/category/similarity, and handler.ts re-derives salary/sponsorship
        // from uk_soc_master.json by code. relatedJobTitles/expandedJobTitles are folded
        // into the embedding text (buildEmbeddingText), not stored as columns.
        const rows = slice.map((occ, j) => ({
            soc_code: occ.code,
            title: occ.title,
            category: occ.category,
            embedding: embeddings[j],
        }));

        await flush(supabase, rows);
        processed += rows.length;
        console.log(`Upserted ${processed}/${occupations.length}`);
    }

    console.log('Done.');
}

async function flush(supabase: ReturnType<typeof createClient<any, any, any>>, rows: Record<string, unknown>[]) {
    const { error } = await supabase.from('uk_soc_occupations').upsert(rows, { onConflict: 'soc_code' });
    if (error) {
        throw new Error(`Upsert failed: ${error.message}`);
    }
}

// Guarded so ingestSocOccupationsGte.ts can reuse buildEmbeddingText/SocOccupationRecord
// without this MiniLM ingest firing on import.
if (require.main === module) {
    main().catch((err) => {
        console.error('Ingestion failed:', err);
        process.exit(1);
    });
}
