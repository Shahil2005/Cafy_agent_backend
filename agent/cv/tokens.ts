import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Exact token count for gte-small (BERT WordPiece, lowercase), the model that embeds CVs and jobs.
 *
 * The model reads at most 512 tokens and silently ignores the rest (measured on the embed-match edge
 * function: texts that differ only after ~560 tokens get identical vectors). Characters are a poor guide:
 * dense skill lists and metrics ("C#, .NET 8, p95 820ms -> 140ms") reach 700+ tokens in 1,500 characters.
 * Counting with the model's own vocabulary lets the chunker cut such text smaller, so every word is read.
 *
 * This mirrors the tokenizer.json of Supabase/gte-small (BertNormalizer: clean text, CJK padding,
 * lowercase + strip accents; BertPreTokenizer; WordPiece "##", 100 chars per word; [CLS] … [SEP]).
 * data/gte-small-vocab.txt is that file's vocabulary, one token per line in id order.
 */

export const MAX_EMBED_TOKENS = 512;
const MAX_WORD_CHARS = 100;
const SPECIAL_TOKENS = 2;

let vocab: Set<string> | null = null;

function loadVocab(): Set<string> {
    vocab ??= new Set(readFileSync(path.join(__dirname, '..', '..', 'data', 'gte-small-vocab.txt'), 'utf8').split('\n').filter(Boolean));
    return vocab;
}

function isControl(code: number): boolean {
    if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
    return /\p{C}/u.test(String.fromCodePoint(code));
}

function isChinese(code: number): boolean {
    return (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x20000 && code <= 0x2a6df) ||
        (code >= 0x2a700 && code <= 0x2b73f) ||
        (code >= 0x2b740 && code <= 0x2b81f) ||
        (code >= 0x2b820 && code <= 0x2ceaf) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x2f800 && code <= 0x2fa1f)
    );
}

function isPunctuation(code: number): boolean {
    if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) return true;
    return /\p{P}/u.test(String.fromCodePoint(code));
}

/** BertNormalizer + BertPreTokenizer: the words WordPiece then splits. */
export function preTokenize(text: string): string[] {
    let clean = '';
    for (const char of text) {
        const code = char.codePointAt(0)!;
        if (code === 0 || code === 0xfffd || isControl(code)) continue;
        if (/\s/u.test(char)) clean += ' ';
        else if (isChinese(code)) clean += ` ${char} `;
        else clean += char;
    }
    // Lowercase, then strip accents (NFD and drop combining marks), as the normalizer does.
    const normal = clean.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    const words: string[] = [];
    for (const chunk of normal.split(' ')) {
        let current = '';
        for (const char of chunk) {
            if (isPunctuation(char.codePointAt(0)!)) {
                if (current) words.push(current);
                words.push(char);
                current = '';
            } else current += char;
        }
        if (current) words.push(current);
    }
    return words;
}

/** WordPiece pieces for one word: greedy longest match; a word that cannot be split is one [UNK]. */
function wordPieces(word: string, known: Set<string>): number {
    const chars = [...word];
    if (chars.length > MAX_WORD_CHARS) return 1;
    let count = 0;
    for (let start = 0; start < chars.length; ) {
        let end = chars.length;
        let found = false;
        while (start < end) {
            const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
            if (known.has(piece)) {
                found = true;
                break;
            }
            end--;
        }
        if (!found) return 1;
        count++;
        start = end;
    }
    return count;
}

/** Tokens the model sees for this text, including [CLS] and [SEP]. */
export function countEmbedTokens(text: string): number {
    const known = loadVocab();
    return preTokenize(text).reduce((sum, word) => sum + wordPieces(word, known), SPECIAL_TOKENS);
}
