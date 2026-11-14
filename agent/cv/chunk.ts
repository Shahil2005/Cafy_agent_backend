import { countEmbedTokens, MAX_EMBED_TOKENS } from './tokens';

/**
 * Splits a CV into sections, then into pieces that fit the gte-small 512-token window.
 * 1,500 characters is about 375 tokens for normal text, leaving room for dense text (numbers,
 * codes, links) so the model never silently ignores the end of a piece. Every character lands in at least one piece: nothing is cut off,
 * and pieces never cross a section boundary so search results stay clear.
 */

export const CHUNK_CHARS = 1500;
export const CHUNK_OVERLAP = 250;
const MIN_CHUNK_CHARS = 40;

/**
 * Text heavy in non-English letters (Vietnamese, Chinese, Arabic...) uses far more tokens per character.
 * A character is at most about one token, so 450 characters always fit the 512-token window.
 */
export const DENSE_CHUNK_CHARS = 450;
export const DENSE_CHUNK_OVERLAP = 100;
const DENSE_LETTER_SHARE = 0.1;

export function isDenseText(text: string): boolean {
    const letters = text.match(/(?![\x00-\x7F])\p{L}/gu)?.length ?? 0;
    return letters >= text.length * DENSE_LETTER_SHARE;
}

/**
 * Shortens decoration such as "__________" or "----------" to 3 symbols. The model counts each
 * symbol as one token, so long divider lines could push a piece past 512 tokens; they carry no meaning.
 */
export function collapseSymbolRuns(text: string): string {
    return text.replace(/([^\p{L}\p{N}\s])\1{3,}/gu, '$1$1$1');
}

export interface CvChunk {
    index: number;
    section: string;
    text: string;
}

const HEADING_WORDS =
    /^(?:(?:professional|personal|work|employment|career|relevant|technical|key|core|academic|additional|other)\s+)*(?:summary|profile|statement|objective|about me|experience|employment(?: history)?|work history|career history|education|qualifications|skills|competencies|projects?|achievements|accomplishments|awards|certifications?|certificates|courses|training|languages|volunteering|volunteer experience|leadership|activities|interests|hobbies|publications|research|references|internships?)(?:\s*(?:&|and)\s*[a-z ]{2,30})?:?$/i;

function isHeading(line: string): boolean {
    const value = line.trim();
    if (!value || value.length > 45) return false;
    if (HEADING_WORDS.test(value)) return true;
    // Short ALL-CAPS lines such as "WORK EXPERIENCE" or "TECHNICAL SKILLS".
    return /^[A-Z][A-Z &/-]{3,40}:?$/.test(value) && /[A-Z]{4}/.test(value);
}

function headingLabel(line: string): string {
    const value = line.trim().replace(/:$/, '').toLowerCase();
    return value.charAt(0).toUpperCase() + value.slice(1);
}

export function splitSections(text: string): Array<{ section: string; text: string }> {
    const sections: Array<{ section: string; lines: string[] }> = [{ section: 'Top of CV', lines: [] }];
    for (const line of collapseSymbolRuns(text.replace(/\r\n?/g, '\n')).split('\n')) {
        if (isHeading(line)) sections.push({ section: headingLabel(line), lines: [] });
        else sections[sections.length - 1]!.lines.push(line);
    }
    return sections
        .map((s) => ({ section: s.section, text: s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() }))
        .filter((s) => s.text.length > 0);
}

/** Line-aware windows with overlap; a single over-long line is split hard. `windowChars` forces a smaller window. */
export function textWindows(text: string, windowChars?: number): string[] {
    const dense = isDenseText(text);
    const maxChars = windowChars ?? (dense ? DENSE_CHUNK_CHARS : CHUNK_CHARS);
    const overlap = windowChars ? Math.round(windowChars / 6) : dense ? DENSE_CHUNK_OVERLAP : CHUNK_OVERLAP;
    if (text.length <= maxChars) return [text];
    const lines = text.split('\n').flatMap((line) => {
        if (line.length <= maxChars) return [line];
        const parts: string[] = [];
        for (let i = 0; i < line.length; i += maxChars - overlap) parts.push(line.slice(i, i + maxChars));
        return parts;
    });
    const out: string[] = [];
    let current: string[] = [];
    let size = 0;
    for (const line of lines) {
        if (size + line.length + 1 > maxChars && current.length) {
            out.push(current.join('\n'));
            // Carry the tail forward so a sentence split across windows still appears whole once.
            const carry: string[] = [];
            let carried = 0;
            for (let i = current.length - 1; i >= 0 && carried + current[i]!.length <= overlap; i--) {
                carry.unshift(current[i]!);
                carried += current[i]!.length + 1;
            }
            current = carry;
            size = carried;
        }
        current.push(line);
        size += line.length + 1;
    }
    if (current.length) out.push(current.join('\n'));
    return out;
}

/** Smaller windows to try, in order, for a piece the model could not read in full. */
const REFIT_SIZES = [1000, 700, 450, 300, 200, 120];

/**
 * A piece over the model's token window is cut again into smaller windows until each one fits.
 * Counted exactly with the model's vocabulary, because dense skill lists and figures use far more
 * tokens per character than prose. Overlapping windows keep every word in at least one piece.
 */
export function fitToModel(section: string, text: string, count: (text: string) => number = countEmbedTokens): string[] {
    const fits = (piece: string) => count(`${section}: ${piece}`) <= MAX_EMBED_TOKENS;
    if (fits(text)) return [text];
    for (const size of REFIT_SIZES) {
        const windows = textWindows(text, size).map((w) => w.trim()).filter(Boolean);
        if (windows.every(fits)) return windows;
    }
    // Unreachable for real text (120 characters is far below 512 tokens); never drop text.
    return textWindows(text, REFIT_SIZES[REFIT_SIZES.length - 1]);
}

export function chunkCv(text: string): CvChunk[] {
    return chunkBySize(text)
        .flatMap((chunk) => fitToModel(chunk.section, chunk.text).map((piece) => ({ section: chunk.section, text: piece })))
        .map((chunk, index) => ({ index, ...chunk }));
}

function chunkBySize(text: string): CvChunk[] {
    const chunks: CvChunk[] = [];
    for (const { section, text: body } of splitSections(text)) {
        for (const piece of textWindows(body)) {
            const trimmed = piece.trim();
            if (trimmed.length < MIN_CHUNK_CHARS && chunks.length) {
                // Tiny fragments are merged into the previous piece of the same section when possible.
                const last = chunks[chunks.length - 1]!;
                if (last.section === section && last.text.length + trimmed.length + 1 <= CHUNK_CHARS) {
                    last.text = `${last.text}\n${trimmed}`;
                    continue;
                }
            }
            if (trimmed) chunks.push({ index: chunks.length, section, text: trimmed });
        }
    }
    return chunks;
}
