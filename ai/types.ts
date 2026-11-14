export type AiProvider = 'gemini' | 'openai';

/** Provider diagnostics. Optional because only Gemini reports them; OpenAI calls omit them. */
export type GenerationDiagnostics = {
    /** 'STOP' = model finished. 'MAX_TOKENS' = truncated (raise maxOutputTokens). */
    finishReason?: string;
    promptTokens?: number;
    /** Native tool-retrieved input (for example URL Context), additional to promptTokens. */
    toolUsePromptTokens?: number;
    outputTokens?: number;
    thoughtsTokens?: number;
    /** Native provider total, retained for usage diagnostics without inferring missing components. */
    totalTokens?: number;
    /** Bounded native envelope counts only; no generated text, tool arguments or URLs. */
    contentParts?: number;
    textParts?: number;
    thoughtParts?: number;
    functionCallParts?: number;
};

/** Display-only Google Search attribution. Never use these links for crawling or indexing. */
export type GoogleSearchGrounding = {
    sources: Array<{ url: string; title: string }>;
    /** UTF-16 offsets into the returned text, suitable for safe React text rendering. */
    citations: Array<{
        startIndex: number;
        endIndex: number;
        sourceIndexes: number[];
    }>;
    searchQueries: string[];
    /** Original provider suggestion labels/links, with executable markup removed. */
    searchSuggestions: Array<{ label: string; url: string }>;
};

/** Provider-owned URL retrieval attempts, used only to validate this request's display links. */
export type GoogleUrlContextMetadata = {
    retrievals: Array<{
        url: string;
        status: 'success' | 'error' | 'paywall' | 'unsafe' | 'unspecified';
    }>;
};

export type ProviderCallResult =
    | ({
          ok: true;
          text: string;
          groundingMetadata?: GoogleSearchGrounding;
          urlContextMetadata?: GoogleUrlContextMetadata;
      } & GenerationDiagnostics)
    | {
          ok: false;
          status: number;
          errorText: string;
          fatal: boolean;
          diagnostics?: GenerationDiagnostics;
      };

export type OrchestratorSuccess = {
    ok: true;
    body: unknown;
    /** Surfaced separately from `body`: the orchestrator rebuilds a synthetic Gemini envelope
     *  containing only the text, so these would otherwise be lost before the caller sees them. */
    diagnostics?: GenerationDiagnostics;
    groundingMetadata?: GoogleSearchGrounding;
    urlContextMetadata?: GoogleUrlContextMetadata;
    provider: AiProvider;
    model: string;
    attempts: number;
    latencyMs: number;
};

export type OrchestratorFailure = {
    ok: false;
    status: number;
    errorText: string;
    diagnostics?: GenerationDiagnostics;
};

export type OrchestratorResult = OrchestratorSuccess | OrchestratorFailure;

export type ModelStep = {
    provider: AiProvider;
    model: string;
    maxAttempts: number;
};
