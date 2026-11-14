import { createHash } from 'node:crypto';
import { CHUNK_CHARS, CHUNK_OVERLAP, DENSE_CHUNK_CHARS, DENSE_CHUNK_OVERLAP, collapseSymbolRuns, isDenseText } from '../cv/chunk';

/**
 * Cuts a job advert into pieces for meaning search, by size only.
 *
 * The full job information is in the description, in no fixed layout, so nothing is labelled or
 * weighted: the title and department lead the text, then the whole description follows, and the
 * text is cut into windows of CHUNK_CHARS (1,500) characters with a 250-character overlap, small
 * enough that the embedding model reads every piece in full. Every word is
 * covered. Pieces keep their offsets into that text, so the text itself is never stored twice.
 */

/** Bump when the cutting changes, so every advert is embedded again. */
const PIECES_VERSION = 'size-v3';
/** The embedding model's window; it silently ignores anything past this. */
export const MAX_PIECE_TOKENS = 512;

export interface JobPiece {
    pieceNo: number;
    /** Offsets into jobText(job). */
    start: number;
    end: number;
    text: string;
}

interface JobText {
    title: string;
    department?: string | null;
    description?: string | null;
}

/** The text that is cut: title and department first, then the full description (divider lines shortened). */
export function jobText(job: JobText): string {
    const head = [job.title, job.department].filter(Boolean).join(' · ');
    return collapseSymbolRuns(job.description ? `${head}\n${job.description}` : head);
}

/** Windows of about CHUNK_CHARS that end at a line, sentence or word break where possible; smaller where the text is dense. */
function windows(text: string, small = false): { ranges: Array<[number, number]>; dense: boolean } {
    const ranges: Array<[number, number]> = [];
    let anyDense = false;
    for (let from = 0; from < text.length; ) {
        const dense = small || isDenseText(text.slice(from, from + CHUNK_CHARS));
        anyDense ||= dense;
        const size = dense ? DENSE_CHUNK_CHARS : CHUNK_CHARS;
        let to = Math.min(text.length, from + size);
        if (to < text.length) {
            const slice = text.slice(from, to);
            const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '), slice.lastIndexOf(' '));
            if (cut > size * 0.5) to = from + cut + 1;
        }
        ranges.push([from, to]);
        if (to >= text.length) break;
        from = Math.max(to - (dense ? DENSE_CHUNK_OVERLAP : CHUNK_OVERLAP), from + 1);
    }
    return { ranges, dense: anyDense };
}

/**
 * The pieces to embed. Some text looks plain but costs many tokens (a Welsh advert reached 638), which
 * only the model's tokenizer can tell: such an advert is cut small throughout, and small pieces always fit.
 */
export function fitJobPieces(job: JobText, countTokens: (text: string) => number): JobPiece[] {
    const pieces = jobPieces(job);
    return pieces.every((p) => countTokens(p.text) <= MAX_PIECE_TOKENS) ? pieces : jobPieces(job, true);
}

export function jobPieces(job: JobText, small = false): JobPiece[] {
    const text = jobText(job);
    return windows(text, small).ranges
        .map(([start, end], i) => ({ pieceNo: i, start, end, text: text.slice(start, end).trim() }))
        .filter((p) => p.text.length > 0)
        .map((p, i) => ({ ...p, pieceNo: i }));
}

/** Changes whenever the embedded text or the cutting changes, so only edited adverts are redone. */
export function jobContentHash(job: JobText): string {
    const text = jobText(job);
    // Only adverts with dense text were cut differently, so only those are embedded again.
    const version = windows(text).dense ? `${PIECES_VERSION}-dense` : PIECES_VERSION;
    return createHash('sha256').update(`${version}\u0000${text}`).digest('hex').slice(0, 32);
}
