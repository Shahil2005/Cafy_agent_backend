import { callEmbedMatch } from '../../ai/careerAnalysis/vectorSearch';

/** Matches the embed-match edge function limits (≤8 chunks, ≤4,200 chars, 2s CPU per call). */
const BATCH_CHAR_BUDGET = 4150;
const MAX_CHUNKS_PER_BATCH = 8;
const MAX_IN_FLIGHT = 5;

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

function batches(texts: string[]): number[][] {
    const out: number[][] = [];
    let current: number[] = [];
    let chars = 0;
    texts.forEach((text, index) => {
        if (current.length && (chars + text.length > BATCH_CHAR_BUDGET || current.length >= MAX_CHUNKS_PER_BATCH)) {
            out.push(current);
            current = [];
            chars = 0;
        }
        current.push(index);
        chars += text.length;
    });
    if (current.length) out.push(current);
    return out;
}

/**
 * Embeds every text with gte-small inside Supabase (`embedOnly`: no database access, no AI tokens).
 * Unlike the SOC matcher there is no chunk cap, so long CVs are covered in full.
 */
export const embedTexts: EmbedFn = async (texts) => {
    const vectors: number[][] = new Array(texts.length);
    const groups = batches(texts);
    let next = 0;
    const worker = async () => {
        while (next < groups.length) {
            const group = groups[next++]!;
            const response = await callEmbedMatch({ chunks: group.map((i) => texts[i]!), embedOnly: true });
            const embeddings = response.embeddings;
            if (!embeddings || embeddings.length !== group.length) throw new Error('Embedding batch returned the wrong shape');
            group.forEach((textIndex, i) => {
                vectors[textIndex] = embeddings[i]!;
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, groups.length) }, worker));
    return vectors;
};

/** gte-small vectors are normalised, so the dot product is the cosine similarity. */
export function cosine(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length && i < b.length; i++) sum += a[i]! * b[i]!;
    return sum;
}
