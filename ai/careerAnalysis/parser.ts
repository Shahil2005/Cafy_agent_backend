import pdf from 'pdf-parse';

/** Client/input PDF that pdf-parse cannot read — not an infra failure. */
export class PdfUnreadableError extends Error {
    readonly code = 'PDF_UNREADABLE' as const;
    readonly reason: string;

    constructor(reason: string, cause?: unknown) {
        super(
            'We could not read this PDF. Please re-export it, or upload a Word (.docx) file instead.'
        );
        this.name = 'PdfUnreadableError';
        this.reason = reason;
        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}

function classifyPdfParseFailure(error: unknown): { unreadable: boolean; reason: string } {
    const raw =
        error && typeof error === 'object'
            ? String((error as { message?: unknown; details?: unknown }).message ||
                  (error as { details?: unknown }).details ||
                  error)
            : String(error || 'unknown');

    const msg = raw.toLowerCase();
    const formatHints = [
        'formaterror',
        'bad xref',
        'xref entry',
        'command token too long',
        'invalid pdf',
        'missing pdf header',
        'encrypted',
        'password',
        'unexpected end',
        'stream must',
        'invalid stream',
        'unable to read',
    ];

    if (formatHints.some((h) => msg.includes(h))) {
        return { unreadable: true, reason: raw.slice(0, 200) };
    }

    // pdf.js often wraps FormatError in UnknownErrorException with details
    const details =
        error && typeof error === 'object'
            ? String((error as { details?: unknown }).details || '')
            : '';
    if (/formaterror|bad xref|command token/i.test(details)) {
        return { unreadable: true, reason: (details || raw).slice(0, 200) };
    }

    return { unreadable: false, reason: raw.slice(0, 200) };
}

/**
 * Extracts raw text from a PDF file buffer on the server side.
 * Uses pdf-parse v1 (no canvas / DOMMatrix) so it is safe on Vercel serverless.
 *
 * Throws PdfUnreadableError for broken/unsupported PDFs (map to HTTP 422).
 * Throws a generic Error for unexpected parser/runtime failures (map to HTTP 500).
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
    try {
        const result = await pdf(buffer);
        return result.text || '';
    } catch (error) {
        const { unreadable, reason } = classifyPdfParseFailure(error);
        console.error('[pdf-parser] Error extracting text from PDF:', {
            unreadable,
            reason,
            error,
        });
        if (unreadable) {
            throw new PdfUnreadableError(reason, error);
        }
        throw new Error('Failed to parse PDF resume on the server.');
    }
}

/** Link annotations worth keeping: web pages, email and phone links. */
const LINK_SCHEME = /^(https?:\/\/|mailto:|tel:)/i;
const MAX_LINKS = 50;

/**
 * Hyperlink targets embedded in a PDF (link annotations). Resumes usually show "LinkedIn" / "GitHub" /
 * "Portfolio" as clickable words whose URL never appears in the text, so extractPdfText alone loses them.
 * Best effort: any failure returns [] so text extraction is never affected.
 */
export async function extractPdfLinks(buffer: Buffer): Promise<string[]> {
    const links = new Set<string>();
    try {
        await pdf(buffer, {
            // Called per page; only the annotations are read, the returned text is discarded
            pagerender: async (pageData: { getAnnotations: () => Promise<Array<{ url?: string; unsafeUrl?: string }>> }) => {
                const annotations = await pageData.getAnnotations().catch(() => []);
                for (const a of annotations) {
                    const url = (a.url ?? a.unsafeUrl ?? '').trim();
                    if (url && LINK_SCHEME.test(url) && links.size < MAX_LINKS) links.add(url);
                }
                return '';
            },
        } as Parameters<typeof pdf>[1]);
    } catch (error) {
        console.warn('[pdf-parser] Could not read PDF links:', error instanceof Error ? error.message : error);
    }
    return [...links];
}

export function isPdfUnreadableError(error: unknown): error is PdfUnreadableError {
    return (
        error instanceof PdfUnreadableError ||
        (typeof error === 'object' &&
            error !== null &&
            (error as { code?: string }).code === 'PDF_UNREADABLE')
    );
}
