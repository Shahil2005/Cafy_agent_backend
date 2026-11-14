import type { AiOperation } from '../billing/aiOperations';

const AUTOFILL_OPERATIONS: ReadonlySet<AiOperation> = new Set(['autofill_profile', 'autofill_fill']);
const AGENT_OPERATIONS: ReadonlySet<AiOperation> = new Set(['agent_turn', 'agent_cv_profile', 'agent_job_fit', 'agent_cv_tailor']);

/**
 * Autofill (AUTOFILL_GEMINI_API_KEY) and the CAFY chat agent (AGENT_GEMINI_API_KEY) use their own
 * keys so each feature's Gemini cost can be tracked separately; everything else uses GEMINI_API_KEY.
 */
export function getGeminiApiKey(operation?: AiOperation): string | undefined {
    if (operation && AUTOFILL_OPERATIONS.has(operation)) {
        return process.env.AUTOFILL_GEMINI_API_KEY?.trim() || undefined;
    }
    if (operation && AGENT_OPERATIONS.has(operation)) {
        return process.env.AGENT_GEMINI_API_KEY?.trim() || undefined;
    }
    return process.env.GEMINI_API_KEY?.trim() || undefined;
}

/** OpenAI API key for gpt-4o-mini fallback. Set in env when ready. */
export function getOpenAiApiKey(): string | undefined {
    return process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function getPrimaryGeminiModel(): string {
    return process.env.AI_PRIMARY_MODEL?.trim() || 'gemini-2.5-flash';
}

/** Search + URL Context + native structured output require Gemini 3 or newer. */
export function supportsStructuredWebDiscovery(model: string): boolean {
    return /^gemini-[34](?:[.-][a-z0-9]+)+$/i.test(model.trim());
}

/** Web discovery has its own server-owned model; ordinary chat/CV models stay unchanged. */
export function getWebDiscoveryModel(): string {
    const configured = process.env.AI_WEB_SEARCH_MODEL?.trim();
    return configured && supportsStructuredWebDiscovery(configured)
        ? configured
        : 'gemini-3.5-flash-lite';
}

/** Dev-only: honor client primary model when BETA_MODE is enabled. */
export function resolvePrimaryGeminiModel(clientOverride?: string): string {
    const override = clientOverride?.trim();
    if (override && process.env.BETA_MODE === 'true' && !isOpenAiModel(override)) {
        return override;
    }
    return getPrimaryGeminiModel();
}

export function isOpenAiModel(model: string): boolean {
    return /^(gpt-|o[134]-)/i.test(model.trim());
}

/** Dev-only: when client sends an OpenAI model name, use it as the sole primary step. */
export function resolveOpenAiPrimaryOverride(clientOverride?: string): string | undefined {
    const override = clientOverride?.trim();
    if (override && process.env.BETA_MODE === 'true' && isOpenAiModel(override)) {
        return override;
    }
    return undefined;
}

/** CAFY chat agent runs on the cheapest capable model; heavier work escalates inside tools. */
export function getAgentModel(): string {
    return process.env.AI_AGENT_MODEL?.trim() || 'gemini-2.5-flash';
}

/** Reading a job advert against a CV: where the cheap model misread most. */
export function getAgentFitModel(): string {
    return process.env.AI_AGENT_FIT_MODEL?.trim() || 'gemini-2.5-flash';
}

/** One-off CV reading for the agent; evidence quotes are verified server-side, so the cheap model is enough. */
export function getAgentCvModel(): string {
    return process.env.AI_AGENT_CV_MODEL?.trim() || 'gemini-2.5-flash-lite';
}

export function getGeminiFallbackModel(): string {
    return process.env.AI_GEMINI_FALLBACK_MODEL?.trim() || 'gemini-2.5-flash-lite';
}

export function getOpenAiFallbackModel(): string {
    return process.env.AI_OPENAI_FALLBACK_MODEL?.trim() || 'gpt-4o-mini';
}

export function getPrimaryMaxAttempts(): number {
    const n = parseInt(process.env.AI_PRIMARY_MAX_ATTEMPTS || '2', 10);
    return Number.isFinite(n) && n >= 1 ? n : 2;
}

export function getGeminiFallbackMaxAttempts(): number {
    const n = parseInt(process.env.AI_GEMINI_FALLBACK_MAX_ATTEMPTS || '1', 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function getOpenAiMaxAttempts(): number {
    const n = parseInt(process.env.AI_OPENAI_MAX_ATTEMPTS || '1', 10);
    return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function getRequestTimeoutMs(): number {
    const n = parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '60000', 10);
    return Number.isFinite(n) && n >= 5000 ? n : 60000;
}

export function getChainMaxDurationMs(): number {
    const n = parseInt(process.env.AI_CHAIN_MAX_DURATION_MS || '35000', 10);
    return Number.isFinite(n) && n >= 10000 ? n : 35000;
}

export function getRetryBackoffMs(): number {
    const n = parseInt(process.env.AI_RETRY_BACKOFF_MS || '2000', 10);
    return Number.isFinite(n) && n >= 0 ? n : 2000;
}
