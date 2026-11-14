import type { GeminiRequestPayload } from './geminiCore';

function extractPartText(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const parts = (value as { parts?: Array<{ text?: string }> }).parts;
    const text = parts?.[0]?.text;
    return typeof text === 'string' ? text : '';
}

export function extractPromptMessages(request: GeminiRequestPayload): {
    systemInstruction: string;
    userQuery: string;
} {
    const contents = Array.isArray(request.contents) ? request.contents[0] : undefined;
    return {
        systemInstruction: extractPartText(request.systemInstruction),
        userQuery: extractPartText(contents),
    };
}
