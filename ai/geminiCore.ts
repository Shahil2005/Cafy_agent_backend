import { buildGenerationConfig, getGeminiProfile } from './profiles';
import type { WebDiscoveryPhase } from './profiles';
import type { AiOperation } from '../billing/aiOperations';
import { getGeminiApiKey, getRequestTimeoutMs } from './config';
import { classifyHttpError } from './errors';
import { isIP } from 'node:net';
import type {
    GenerationDiagnostics,
    GoogleSearchGrounding,
    GoogleUrlContextMetadata,
    ProviderCallResult,
} from './types';

export type GeminiRequestPayload = {
    contents: unknown;
    systemInstruction: unknown;
    /** Server-only discovery workflow choice; never a raw tool/config override. */
    webDiscoveryPhase?: WebDiscoveryPhase;
};

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Envelope diagnostics cannot contain prompts, generated content, arguments or source URLs. */
function generationDiagnostics(
    data: unknown,
    candidate: Record<string, unknown> | undefined,
): GenerationDiagnostics {
    const usage =
        object(data) && object(data.usageMetadata) ? data.usageMetadata : {};
    const count = (value: unknown): number | undefined =>
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 1_000_000_000
            ? value
            : undefined;
    const parts =
        candidate &&
        object(candidate.content) &&
        Array.isArray(candidate.content.parts)
            ? candidate.content.parts.slice(0, 32_768)
            : [];
    const finishReason =
        typeof candidate?.finishReason === 'string' &&
        /^[A-Z_0-9]{1,80}$/.test(candidate.finishReason)
            ? candidate.finishReason
            : undefined;
    const toolUsePromptTokens = count(usage.toolUsePromptTokenCount);
    const totalTokens = count(usage.totalTokenCount);
    return {
        finishReason,
        promptTokens: count(usage.promptTokenCount),
        outputTokens: count(usage.candidatesTokenCount),
        thoughtsTokens: count(usage.thoughtsTokenCount),
        ...(toolUsePromptTokens !== undefined ? { toolUsePromptTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        contentParts: parts.length,
        textParts: parts.filter(
            (part) =>
                object(part) &&
                part.thought !== true &&
                typeof part.text === 'string',
        ).length,
        thoughtParts: parts.filter(
            (part) => object(part) && part.thought === true,
        ).length,
        functionCallParts: parts.filter(
            (part) => object(part) && object(part.functionCall),
        ).length,
    };
}

function boundedText(value: unknown, max: number): string | null {
    return typeof value === 'string' &&
        value.trim() &&
        value.length <= max &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
        ? value
        : null;
}

/** Attribution links are displayed only. They are never a source for automated fetching. */
function publicAttributionUrl(value: unknown): string | null {
    if (
        typeof value !== 'string' ||
        value.length > 2048 ||
        /[\u0000-\u0020\u007f]/.test(value)
    )
        return null;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            (url.port && url.port !== '443') ||
            !host.includes('.') ||
            isIP(host.replace(/^\[|\]$/g, '')) ||
            /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(
                host,
            ) ||
            /(?:^|\.)(?:localhost\.localdomain|home\.arpa)$/.test(host)
        )
            return null;
        return url.href;
    } catch {
        return null;
    }
}

function googleSuggestionUrl(value: unknown): string | null {
    const safe = publicAttributionUrl(value);
    if (!safe) return null;
    const url = new URL(safe);
    const directSearch =
        /^(?:www\.)?google\.(?:com|co\.uk|ie)$/.test(url.hostname) &&
        url.pathname === '/search';
    // Current Google widgets wrap their own Search suggestions in this exact
    // provider redirect. Preserve it for the student's click; never resolve it
    // programmatically or replace it with a guessed search URL.
    const providerRedirect =
        url.hostname === 'vertexaisearch.cloud.google.com' &&
        url.pathname.startsWith('/grounding-api-redirect/') &&
        url.pathname.length > '/grounding-api-redirect/'.length;
    if (!directSearch && !providerRedirect) return null;
    return safe;
}

function decodeEntities(value: string): string {
    return value.replace(
        /&(?:amp|quot|apos|lt|gt|nbsp|#\d{1,7}|#x[a-f\d]{1,6});/gi,
        (entity) => {
            const name = entity.slice(1, -1).toLowerCase();
            const named: Record<string, string> = {
                amp: '&',
                quot: '"',
                apos: "'",
                lt: '<',
                gt: '>',
                nbsp: ' ',
            };
            if (named[name] !== undefined) return named[name]!;
            const code = name.startsWith('#x')
                ? parseInt(name.slice(2), 16)
                : parseInt(name.slice(1), 10);
            return code > 0 &&
                code <= 0x10ffff &&
                !(code >= 0xd800 && code <= 0xdfff)
                ? String.fromCodePoint(code)
                : '';
        },
    );
}

/** Render native SDK tuples or original widget anchors as safe text/link pairs, never raw HTML. */
function searchSuggestions(
    entry: unknown,
): GoogleSearchGrounding['searchSuggestions'] {
    if (!object(entry)) return [];
    const suggestions: GoogleSearchGrounding['searchSuggestions'] = [];
    const add = (labelValue: unknown, urlValue: unknown) => {
        const label = boundedText(labelValue, 200);
        const url = googleSuggestionUrl(urlValue);
        if (
            label &&
            url &&
            suggestions.length < 5 &&
            !suggestions.some((item) => item.url === url)
        )
            suggestions.push({ label, url });
    };
    if (
        typeof entry.sdkBlob === 'string' &&
        entry.sdkBlob.length <= 30_000 &&
        /^[a-z\d+/_=-]+$/i.test(entry.sdkBlob)
    ) {
        try {
            const tuples: unknown = JSON.parse(
                Buffer.from(entry.sdkBlob, 'base64').toString('utf8'),
            );
            if (Array.isArray(tuples)) {
                for (const tuple of tuples.slice(0, 20))
                    if (Array.isArray(tuple) && tuple.length === 2)
                        add(tuple[0], tuple[1]);
            }
        } catch {
            // Missing/malformed native tuples can use the original widget's display anchors.
        }
    }
    if (
        !suggestions.length &&
        typeof entry.renderedContent === 'string' &&
        entry.renderedContent.length <= 50_000
    ) {
        // The bounded, non-executable extraction is for displaying provider suggestions only.
        // It is deliberately not a general HTML renderer or a web-link discovery API.
        const anchors = entry.renderedContent.matchAll(
            /<a\b([^>]{0,4096})>([\s\S]{0,4096}?)<\/a\s*>/gi,
        );
        let examined = 0;
        for (const anchor of anchors) {
            if (++examined > 40 || suggestions.length >= 5) break;
            const href = anchor[1]!.match(
                /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
            );
            if (!href) continue;
            const label = decodeEntities(
                anchor[2]!.replace(/<[^>]*>/g, ''),
            ).trim();
            add(label, decodeEntities(href[1] ?? href[2] ?? ''));
        }
    }
    return suggestions;
}

type CandidateTextPart = {
    index: number;
    text: string;
    startIndex: number;
    bytes: Buffer;
};

function candidateTextParts(
    candidate: Record<string, unknown>,
): CandidateTextPart[] {
    const content = object(candidate.content) ? candidate.content : {};
    const parts =
        Array.isArray(content.parts) && content.parts.length <= 32
            ? content.parts
            : [];
    const result: CandidateTextPart[] = [];
    let startIndex = 0;
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (
            !object(part) ||
            part.thought === true ||
            typeof part.text !== 'string'
        )
            continue;
        if (startIndex + part.text.length > 20_000) return [];
        result.push({
            index,
            text: part.text,
            startIndex,
            bytes: Buffer.from(part.text, 'utf8'),
        });
        startIndex += part.text.length;
    }
    return result;
}

/** Only provider envelope metadata is accepted; generated text is never parsed for sources. */
export function readGoogleSearchGrounding(
    candidate: unknown,
): GoogleSearchGrounding | undefined {
    if (!object(candidate) || !object(candidate.groundingMetadata))
        return undefined;
    const metadata = candidate.groundingMetadata;
    const sources: GoogleSearchGrounding['sources'] = [];
    const sourceMapping = new Map<number, number>();
    const chunks = Array.isArray(metadata.groundingChunks)
        ? metadata.groundingChunks.slice(0, 64)
        : [];
    for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (!object(chunk) || !object(chunk.web)) continue;
        const url = publicAttributionUrl(chunk.web.uri);
        if (!url) continue;
        const existing = sources.findIndex((source) => source.url === url);
        if (existing >= 0) {
            sourceMapping.set(index, existing);
            continue;
        }
        if (sources.length >= 12) continue;
        sourceMapping.set(index, sources.length);
        sources.push({
            url,
            title: boundedText(chunk.web.title, 300) || new URL(url).hostname,
        });
    }
    const searchQueries = Array.isArray(metadata.webSearchQueries)
        ? [
              ...new Set(
                  metadata.webSearchQueries
                      .slice(0, 24)
                      .map((query) => boundedText(query, 500))
                      .filter((query): query is string => Boolean(query)),
              ),
          ].slice(0, 12)
        : [];
    const citations: GoogleSearchGrounding['citations'] = [];
    const parts = candidateTextParts(candidate);
    const supports = Array.isArray(metadata.groundingSupports)
        ? metadata.groundingSupports.slice(0, 100)
        : [];
    for (const support of supports) {
        if (
            !object(support) ||
            !object(support.segment) ||
            !Array.isArray(support.groundingChunkIndices)
        )
            continue;
        const segment = support.segment;
        const part = parts.find(
            (item) => item.index === (segment.partIndex ?? 0),
        );
        const start = segment.startIndex ?? 0;
        const end = segment.endIndex;
        if (
            !part ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            (start as number) < 0 ||
            (end as number) <= (start as number) ||
            (end as number) > part.bytes.length
        )
            continue;
        // UTF-8 boundaries must not cut a code point. Provider offsets are bytes,
        // while React/JavaScript text offsets use UTF-16 code units.
        const prefix = part.bytes.subarray(0, start as number).toString('utf8');
        const cited = part.bytes
            .subarray(start as number, end as number)
            .toString('utf8');
        if (
            Buffer.byteLength(prefix, 'utf8') !== start ||
            Buffer.byteLength(cited, 'utf8') !==
                (end as number) - (start as number)
        )
            continue;
        if (typeof segment.text !== 'string' || segment.text !== cited)
            continue;
        const sourceIndexes = [
            ...new Set(
                support.groundingChunkIndices
                    .slice(0, 64)
                    .filter(
                        (index): index is number =>
                            typeof index === 'number' &&
                            Number.isSafeInteger(index),
                    )
                    .map((index) => sourceMapping.get(index))
                    .filter((index): index is number => index !== undefined),
            ),
        ];
        if (!sourceIndexes.length) continue;
        citations.push({
            startIndex: part.startIndex + prefix.length,
            endIndex: part.startIndex + prefix.length + cited.length,
            sourceIndexes,
        });
    }
    citations.sort(
        (first, second) =>
            first.endIndex - second.endIndex ||
            first.startIndex - second.startIndex,
    );
    return {
        sources,
        citations,
        searchQueries,
        searchSuggestions: searchSuggestions(metadata.searchEntryPoint),
    };
}

/** Only native provider metadata can establish that a URL was retrieved; model text cannot. */
export function readGoogleUrlContextMetadata(
    candidate: unknown,
): GoogleUrlContextMetadata | undefined {
    if (!object(candidate)) return undefined;
    const metadata =
        candidate.urlContextMetadata ?? candidate.url_context_metadata;
    if (!object(metadata)) return undefined;
    const attempts = metadata.urlMetadata ?? metadata.url_metadata;
    if (!Array.isArray(attempts)) return undefined;
    const statuses: Record<
        string,
        GoogleUrlContextMetadata['retrievals'][number]['status']
    > = {
        URL_RETRIEVAL_STATUS_SUCCESS: 'success',
        URL_RETRIEVAL_STATUS_ERROR: 'error',
        URL_RETRIEVAL_STATUS_PAYWALL: 'paywall',
        URL_RETRIEVAL_STATUS_UNSAFE: 'unsafe',
        URL_RETRIEVAL_STATUS_UNSPECIFIED: 'unspecified',
    };
    const retrievals: GoogleUrlContextMetadata['retrievals'] = [];
    for (const attempt of attempts.slice(0, 20)) {
        if (!object(attempt)) continue;
        const url = publicAttributionUrl(
            attempt.retrievedUrl ?? attempt.retrieved_url,
        );
        const rawStatus =
            attempt.urlRetrievalStatus ?? attempt.url_retrieval_status;
        if (!url || typeof rawStatus !== 'string' || !statuses[rawStatus])
            continue;
        retrievals.push({ url, status: statuses[rawStatus]! });
    }
    return { retrievals };
}

export function buildServerControlledPayload(
    operation: AiOperation,
    request: GeminiRequestPayload,
    model: string,
): Record<string, unknown> {
    const profile = getGeminiProfile(operation);
    const webDiscoveryPhase =
        operation === 'jobs_web_discovery'
            ? request.webDiscoveryPhase
            : undefined;
    if (
        webDiscoveryPhase !== undefined &&
        webDiscoveryPhase !== 'search' &&
        webDiscoveryPhase !== 'extract'
    )
        throw new Error('Invalid server web discovery phase');
    const payload: Record<string, unknown> = {
        contents: request.contents,
        systemInstruction: request.systemInstruction,
        generationConfig: buildGenerationConfig(operation, {
            model,
            webDiscoveryPhase,
        }),
    };
    if (profile.tools) {
        payload.tools =
            webDiscoveryPhase === 'search'
                ? [{ googleSearch: {} }]
                : profile.tools;
    }
    return payload;
}

export async function callGemini(
    operation: AiOperation,
    request: GeminiRequestPayload,
    model: string,
    signal?: AbortSignal,
): Promise<ProviderCallResult> {
    const apiKey = getGeminiApiKey(operation);
    if (!apiKey) {
        return {
            ok: false,
            status: 500,
            errorText: 'Server configuration error',
            fatal: true,
        };
    }

    // Keep credentials out of request URLs, which HTTP tracing can record.
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const payload = buildServerControlledPayload(operation, request, model);

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(payload),
            signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            const { retryable, fatal } = classifyHttpError(response.status);
            return {
                ok: false,
                status: response.status,
                errorText,
                fatal: fatal || !retryable,
            };
        }

        const data = await response.json();
        const candidate =
            object(data) &&
            Array.isArray(data.candidates) &&
            object(data.candidates[0])
                ? data.candidates[0]
                : undefined;
        const text =
            operation === 'jobs_web_discovery' && candidate
                ? candidateTextParts(candidate)
                      .map((part) => part.text)
                      .join('')
                : (
                      data as {
                          candidates?: Array<{
                              content?: { parts?: Array<{ text?: string }> };
                          }>;
                      }
                  ).candidates?.[0]?.content?.parts?.[0]?.text;
        const diagnostics = generationDiagnostics(data, candidate);

        if (!text) {
            return {
                ok: false,
                status: 502,
                errorText: 'Gemini returned empty content',
                fatal: false,
                diagnostics,
            };
        }

        // finishReason distinguishes "model chose to stop" from "hit the token ceiling"; the
        // token counts make an under-length response diagnosable instead of guesswork.
        const groundingMetadata =
            operation === 'jobs_web_discovery'
                ? readGoogleSearchGrounding(candidate)
                : undefined;
        const urlContextMetadata =
            operation === 'jobs_web_discovery'
                ? readGoogleUrlContextMetadata(candidate)
                : undefined;
        return {
            ok: true,
            text,
            ...diagnostics,
            ...(groundingMetadata ? { groundingMetadata } : {}),
            ...(urlContextMetadata ? { urlContextMetadata } : {}),
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            return {
                ok: false,
                status: 504,
                errorText: 'Gemini request timed out',
                fatal: false,
            };
        }
        const message =
            error instanceof Error ? error.message : 'Gemini request failed';
        return { ok: false, status: 503, errorText: message, fatal: false };
    }
}

export function createGeminiTimeoutSignal(
    parent?: AbortSignal,
    timeoutMs?: number,
): {
    signal: AbortSignal;
    cleanup: () => void;
} {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        timeoutMs ?? getRequestTimeoutMs(),
    );

    const onParentAbort = () => controller.abort();
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener('abort', onParentAbort, { once: true });

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeout);
            parent?.removeEventListener('abort', onParentAbort);
        },
    };
}
