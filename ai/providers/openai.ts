import type { AiOperation } from '../../billing/aiOperations';
import { getOpenAiApiKey, getRequestTimeoutMs } from '../config';
import { classifyHttpError } from '../errors';
import { getGeminiProfile } from '../profiles';
import type { ProviderCallResult } from '../types';

export async function callOpenAi(
    operation: AiOperation,
    systemInstruction: string,
    userQuery: string,
    model: string,
    signal?: AbortSignal,
): Promise<ProviderCallResult> {
    const apiKey = getOpenAiApiKey();
    if (!apiKey) {
        return {
            ok: false,
            status: 500,
            errorText: 'OpenAI API key not configured',
            fatal: false,
        };
    }

    const profile = getGeminiProfile(operation);

    try {
        const response = await fetch(
            'https://api.openai.com/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: systemInstruction },
                        { role: 'user', content: userQuery },
                    ],
                    temperature: profile.temperature,
                    max_tokens: profile.maxOutputTokens,
                    ...(profile.jsonOutput
                        ? { response_format: { type: 'json_object' } }
                        : {}),
                }),
                signal,
            },
        );

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

        const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content;
        if (!text) {
            return {
                ok: false,
                status: 502,
                errorText: 'OpenAI returned empty content',
                fatal: false,
            };
        }

        return { ok: true, text };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            return {
                ok: false,
                status: 504,
                errorText: 'OpenAI request timed out',
                fatal: false,
            };
        }
        const message =
            error instanceof Error ? error.message : 'OpenAI request failed';
        return { ok: false, status: 503, errorText: message, fatal: false };
    }
}

export function createOpenAiTimeoutSignal(
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
