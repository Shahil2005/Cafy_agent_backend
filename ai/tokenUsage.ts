import type { GenerationDiagnostics } from './types';

export interface BillableTokenUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}

function validCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

/**
 * Gemini bills URL Context retrieval as input and thinking as output. Missing
 * component counters remain unknown unless the native total proves their sum.
 * A positive remainder cannot be allocated when both input and output are incomplete.
 */
export function billableTokenUsage(diagnostics?: GenerationDiagnostics): BillableTokenUsage {
    if (!diagnostics) return {};
    const prompt = validCount(diagnostics.promptTokens) ? diagnostics.promptTokens : undefined;
    const tool = validCount(diagnostics.toolUsePromptTokens) ? diagnostics.toolUsePromptTokens : undefined;
    const candidates = validCount(diagnostics.outputTokens) ? diagnostics.outputTokens : undefined;
    const thoughts = validCount(diagnostics.thoughtsTokens) ? diagnostics.thoughtsTokens : undefined;
    const knownInput = (prompt ?? 0) + (tool ?? 0);
    const knownOutput = (candidates ?? 0) + (thoughts ?? 0);
    let inputTokens = prompt !== undefined && tool !== undefined ? knownInput : undefined;
    let outputTokens = candidates !== undefined && thoughts !== undefined ? knownOutput : undefined;
    const nativeTotal = validCount(diagnostics.totalTokens) && diagnostics.totalTokens >= knownInput + knownOutput
        ? diagnostics.totalTokens
        : undefined;
    if (nativeTotal !== undefined) {
        if (nativeTotal === knownInput + knownOutput) {
            // Nonnegative omitted categories must all be zero when nothing remains.
            inputTokens = knownInput;
            outputTokens = knownOutput;
        } else if (inputTokens !== undefined && outputTokens === undefined) {
            outputTokens = nativeTotal - inputTokens;
        } else if (outputTokens !== undefined && inputTokens === undefined) {
            inputTokens = nativeTotal - outputTokens;
        } else if (inputTokens !== undefined && outputTokens !== undefined) {
            // A contradictory positive remainder has no defensible category.
            inputTokens = undefined;
            outputTokens = undefined;
        }
    }
    const totalTokens = nativeTotal ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    return {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
}
