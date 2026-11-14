import type { AiOperation } from '../billing/aiOperations';
import {
    getChainMaxDurationMs,
    getGeminiFallbackMaxAttempts,
    getGeminiFallbackModel,
    getOpenAiFallbackModel,
    getOpenAiMaxAttempts,
    getOpenAiApiKey,
    getPrimaryMaxAttempts,
    getRequestTimeoutMs,
    getRetryBackoffMs,
    resolveOpenAiPrimaryOverride,
    resolvePrimaryGeminiModel,
    getWebDiscoveryModel,
    getAgentModel,
    getAgentCvModel,
    getAgentFitModel,
    getPrimaryGeminiModel,
} from './config';
import { backoffMs } from './errors';
import { callGemini, type GeminiRequestPayload } from './geminiCore';
import { wrapAsGeminiResponse } from './normalizeResponse';
import { extractPromptMessages } from './promptUtils';
import { callOpenAi, createOpenAiTimeoutSignal } from './providers/openai';
import { createGeminiTimeoutSignal } from './geminiCore';
import type {
    GenerationDiagnostics,
    ModelStep,
    OrchestratorResult,
} from './types';

function buildModelChain(
    operation: AiOperation,
    primaryModel?: string,
): ModelStep[] {
    // This operation requires Google's actual Search attribution. An ordinary
    // OpenAI fallback would turn live research into an ungrounded model answer.
    const requiresGoogleSearch = operation === 'jobs_web_discovery';
    if (requiresGoogleSearch) {
        return [
            {
                provider: 'gemini',
                model: getWebDiscoveryModel(),
                maxAttempts: getPrimaryMaxAttempts(),
            },
        ];
    }
    // The agent starts on the cheap model and falls back to the stronger one, then OpenAI.
    if (operation === 'agent_turn' || operation === 'agent_cv_profile' || operation === 'agent_job_fit' || operation === 'agent_cv_tailor') {
        const agentChain: ModelStep[] = [
            {
                provider: 'gemini',
                // Tailoring writes a whole CV from the CV and the advert, like reading an advert against a CV.
                model: operation === 'agent_cv_profile' ? getAgentCvModel() : operation === 'agent_job_fit' || operation === 'agent_cv_tailor' ? getAgentFitModel() : getAgentModel(),
                maxAttempts: getPrimaryMaxAttempts(),
            },
            { provider: 'gemini', model: getPrimaryGeminiModel(), maxAttempts: getGeminiFallbackMaxAttempts() },
        ];
        if (getOpenAiApiKey()) {
            agentChain.push({ provider: 'openai', model: getOpenAiFallbackModel(), maxAttempts: getOpenAiMaxAttempts() });
        }
        return agentChain;
    }
    const openAiPrimary = requiresGoogleSearch
        ? undefined
        : resolveOpenAiPrimaryOverride(primaryModel);
    if (openAiPrimary) {
        if (!getOpenAiApiKey()) {
            console.warn(
                '[ai] OpenAI primary override ignored — missing OPENAI_API_KEY',
            );
        } else {
            return [
                {
                    provider: 'openai',
                    model: openAiPrimary,
                    maxAttempts: getPrimaryMaxAttempts(),
                },
            ];
        }
    }

    const chain: ModelStep[] = [
        {
            provider: 'gemini',
            model: resolvePrimaryGeminiModel(primaryModel),
            maxAttempts: getPrimaryMaxAttempts(),
        },
        {
            provider: 'gemini',
            model: getGeminiFallbackModel(),
            maxAttempts: getGeminiFallbackMaxAttempts(),
        },
    ];

    if (!requiresGoogleSearch && getOpenAiApiKey()) {
        chain.push({
            provider: 'openai',
            model: getOpenAiFallbackModel(),
            maxAttempts: getOpenAiMaxAttempts(),
        });
    }

    return chain;
}

export interface AiGenerationOptions {
    primaryModel?: string;
    signal?: AbortSignal;
    /** Complete budget including provider calls and retry backoff. Maximum 120 seconds. */
    timeoutMs?: number;
    /** Physical provider calls across every model in the chain. Maximum eight. */
    maxTotalAttempts?: number;
}

/** The caller's deadline still holds if a provider ignores the fetch abort signal. */
function untilAborted<T>(
    task: Promise<T>,
    signal: AbortSignal,
): Promise<T | null> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            resolve(null);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // Handle a late rejection even after cancellation to prevent an
        // unhandled rejection from a request the caller has already abandoned.
        task.then(
            (result) => {
                signal.removeEventListener('abort', onAbort);
                resolve(signal.aborted ? null : result);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                if (signal.aborted) resolve(null);
                else reject(error);
            },
        );
        if (signal.aborted) onAbort();
    });
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        if (signal.aborted) finish();
        else signal.addEventListener('abort', finish, { once: true });
    });
}

export async function executeAiGeneration(
    operation: AiOperation,
    request: GeminiRequestPayload,
    options?: AiGenerationOptions,
): Promise<OrchestratorResult> {
    const chain = buildModelChain(operation, options?.primaryModel);
    const { systemInstruction, userQuery } = extractPromptMessages(request);
    const startedAt = Date.now();
    const baseBackoff = getRetryBackoffMs();
    const requestedBudget = options?.timeoutMs ?? getChainMaxDurationMs();
    const budgetMs = Number.isFinite(requestedBudget)
        ? Math.max(
              0,
              Math.floor(
                  options?.timeoutMs === undefined
                      ? requestedBudget
                      : Math.min(120_000, requestedBudget),
              ),
          )
        : getChainMaxDurationMs();
    const attemptsLimit =
        options?.maxTotalAttempts === undefined
            ? Infinity
            : Number.isFinite(options.maxTotalAttempts)
              ? Math.max(1, Math.min(8, Math.floor(options.maxTotalAttempts)))
              : 1;
    if (options?.signal?.aborted)
        return { ok: false, status: 499, errorText: 'AI generation cancelled' };
    if (!budgetMs)
        return { ok: false, status: 504, errorText: 'AI generation timed out' };
    const deadlineAt = startedAt + budgetMs;
    let totalAttempts = 0;
    let lastStatus = 500;
    let lastErrorText = 'AI generation failed';
    let lastDiagnostics: GenerationDiagnostics | undefined;

    const chainAbort = new AbortController();
    const onParentAbort = () => chainAbort.abort();
    options?.signal?.addEventListener('abort', onParentAbort, { once: true });
    const deadline = setTimeout(() => chainAbort.abort(), budgetMs);
    const remainingMs = () => Math.max(0, deadlineAt - Date.now());
    const stopped = () => chainAbort.signal.aborted || remainingMs() <= 0;
    const stoppedResult = (): OrchestratorResult => ({
        ok: false,
        status: options?.signal?.aborted ? 499 : 504,
        errorText: options?.signal?.aborted
            ? 'AI generation cancelled'
            : 'AI generation timed out',
    });

    try {
        for (const step of chain) {
            if (stopped()) return stoppedResult();
            if (totalAttempts >= attemptsLimit) break;
            for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
                if (stopped()) return stoppedResult();
                if (totalAttempts >= attemptsLimit) break;
                totalAttempts++;
                const callBudgetMs = Math.max(
                    1,
                    Math.min(getRequestTimeoutMs(), remainingMs()),
                );
                const timeout =
                    step.provider === 'gemini'
                        ? createGeminiTimeoutSignal(
                              chainAbort.signal,
                              callBudgetMs,
                          )
                        : createOpenAiTimeoutSignal(
                              chainAbort.signal,
                              callBudgetMs,
                          );
                try {
                    const pending =
                        step.provider === 'gemini'
                            ? callGemini(
                                  operation,
                                  request,
                                  step.model,
                                  timeout.signal,
                              )
                            : callOpenAi(
                                  operation,
                                  systemInstruction,
                                  userQuery,
                                  step.model,
                                  timeout.signal,
                              );
                    const result = await untilAborted(pending, timeout.signal);
                    if (stopped()) return stoppedResult();
                    if (!result) {
                        lastStatus = 504;
                        lastErrorText = 'AI provider timed out';
                        continue;
                    }
                    if (result.ok) {
                        console.log('[ai] Generation succeeded', {
                            operation,
                            provider: step.provider,
                            model: step.model,
                            attempt,
                            totalAttempts,
                            durationMs: Date.now() - startedAt,
                        });
                        return {
                            ok: true,
                            body: wrapAsGeminiResponse(result.text),
                            diagnostics: {
                                finishReason: result.finishReason,
                                promptTokens: result.promptTokens,
                                outputTokens: result.outputTokens,
                                thoughtsTokens: result.thoughtsTokens,
                                ...(result.toolUsePromptTokens !== undefined
                                    ? { toolUsePromptTokens: result.toolUsePromptTokens }
                                    : {}),
                                ...(result.totalTokens !== undefined
                                    ? { totalTokens: result.totalTokens }
                                    : {}),
                                contentParts: result.contentParts,
                                textParts: result.textParts,
                                thoughtParts: result.thoughtParts,
                                functionCallParts: result.functionCallParts,
                            },
                            ...(result.groundingMetadata
                                ? {
                                      groundingMetadata:
                                          result.groundingMetadata,
                                  }
                                : {}),
                            ...(result.urlContextMetadata
                                ? {
                                      urlContextMetadata:
                                          result.urlContextMetadata,
                                  }
                                : {}),
                            provider: step.provider,
                            model: step.model,
                            attempts: totalAttempts,
                            latencyMs: Date.now() - startedAt,
                        };
                    }
                    lastStatus = result.status;
                    lastErrorText = result.errorText;
                    lastDiagnostics = result.diagnostics;
                    console.warn('[ai] Provider attempt failed', {
                        operation,
                        provider: step.provider,
                        model: step.model,
                        attempt,
                        status: result.status,
                        fatal: result.fatal,
                    });
                    if (result.fatal)
                        return {
                            ok: false,
                            status: result.status,
                            errorText: result.errorText,
                            ...(lastDiagnostics
                                ? { diagnostics: lastDiagnostics }
                                : {}),
                        };
                    const canRetry =
                        attempt < step.maxAttempts &&
                        totalAttempts < attemptsLimit;
                    if (canRetry && !stopped()) {
                        await waitForRetry(
                            Math.min(
                                backoffMs(baseBackoff, attempt),
                                remainingMs(),
                            ),
                            chainAbort.signal,
                        );
                        continue;
                    }
                    break;
                } finally {
                    timeout.cleanup();
                }
            }
        }
        if (stopped()) return stoppedResult();
        console.error('[ai] All providers failed', {
            operation,
            totalAttempts,
            lastStatus,
            durationMs: Date.now() - startedAt,
        });
        return {
            ok: false,
            status: lastStatus,
            errorText: lastErrorText,
            ...(lastDiagnostics ? { diagnostics: lastDiagnostics } : {}),
        };
    } finally {
        clearTimeout(deadline);
        options?.signal?.removeEventListener('abort', onParentAbort);
    }
}
