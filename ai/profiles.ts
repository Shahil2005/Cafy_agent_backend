import type { AiOperation } from '../billing/aiOperations';
import { supportsStructuredWebDiscovery } from './config';
import { WEB_DISCOVERY_RESPONSE_SCHEMA } from './webDiscoverySchema';

export type WebDiscoveryPhase = 'search' | 'extract';

export type GeminiProfile = {
    temperature: number;
    maxOutputTokens: number;
    /** Gemini 2.5 thinking tokens. Omit/0 to disable. Only worth spending on operations whose
     *  output the model demonstrably under-delivers without it (see career_path_analysis). */
    thinkingBudget?: number;
    /** Ask the provider for a bare JSON object (Gemini responseMimeType / OpenAI json_object). */
    jsonOutput?: boolean;
    tools?: Array<
        | { googleSearch: Record<string, never> }
        | { urlContext: Record<string, never> }
    >;
};

const PROFILES: Record<AiOperation, GeminiProfile> = {
    jobs_cv_profile: {
        temperature: 0,
        // One bounded whole-CV extraction, reused throughout the matching session.
        maxOutputTokens: 4096,
        jsonOutput: true,
    },
    jobs_cv_fit: {
        temperature: 0,
        // Up to five adverts x four ratings and one short highlight per call.
        maxOutputTokens: 4096,
        jsonOutput: true,
    },
    jobs_cv_roles: {
        temperature: 0,
        // A short list of equivalent job titles for one requested occupation.
        maxOutputTokens: 512,
        jsonOutput: true,
    },
    jobs_web_discovery: {
        temperature: 0,
        maxOutputTokens: 3072,
        // Keep native JSON for legacy callers without an explicit workflow phase.
        // The chat extraction phase uses plain URL Context and validates JSON on the server.
        jsonOutput: true,
        // Search is an explicit plain-text phase; extraction only reads supplied URLs.
        tools: [{ urlContext: {} }],
    },
    jobs_search_chat: {
        temperature: 0,
        // Expanded structured criteria and bounded clarification labels, never generated job cards.
        maxOutputTokens: 1024,
        jsonOutput: true,
    },
    agent_turn: {
        // Light warmth for natural replies; facts come from tool results, never the model.
        temperature: 0.3,
        // One planning step or one final answer with UI pieces and chips.
        maxOutputTokens: 2048,
        jsonOutput: true,
    },
    agent_job_fit: {
        temperature: 0,
        maxOutputTokens: 8192,
        jsonOutput: true,
    },
    agent_cv_tailor: {
        // A little freedom in wording; every fact is checked against the CV and answers in code.
        temperature: 0.2,
        // A whole tailored CV (long CVs keep every role). A cap, not a target.
        maxOutputTokens: 12288,
        jsonOutput: true,
    },
    agent_cv_profile: {
        temperature: 0,
        // Whole-CV structured profile with evidence quotes, extracted once per CV version.
        // A cap, not a target: only tokens actually written are billed. 16k is also the
        // OpenAI fallback's ceiling; long CVs are read in parts, so each part fits well within it.
        maxOutputTokens: 16384,
        jsonOutput: true,
    },
    comm_cover_letter: {
        temperature: 0,
        maxOutputTokens: 4096,
    },
    comm_email: {
        temperature: 0,
        maxOutputTokens: 2048,
    },
    career_path_analysis: {
        temperature: 0,
        // 10 recommendations x (reason + availableInResume + 4-6 gap points + 5-8 sub-roles)
        // plus employabilityFeedback runs ~7k output tokens when the model actually complies,
        // which sat right on the old 8192 ceiling - a verbose run truncated mid-JSON and became
        // AI_INVALID_FORMAT. This is a cap, not a target: unused headroom costs nothing.
        maxOutputTokens: 24576,
        // MEASURED, not assumed: once the prompt states "EXACTLY 10 OBJECTS" explicitly and the
        // shortlist is built from the chunked (full-resume) match, gemini-2.5-flash returns all
        // 10 with thinking DISABLED - verified on both a content-rich CV and a sparse 608-char
        // student CV. Budgets of 512/1024 spent 483/834 thought tokens and +5-6s latency for the
        // same 10 recommendations. So the default stays 0; the earlier 2-then-5 truncation was a
        // prompt problem, not a reasoning-capacity one. Raise AI_CAREER_THINKING_BUDGET only if
        // real resumes start under-delivering (the Generation stats log will show it).
        thinkingBudget: undefined, // resolved per call from env - see getGeminiProfile
    },
    linkedin_optimizer: {
        temperature: 0,
        maxOutputTokens: 4096,
    },
    autofill_profile: {
        temperature: 0,
        // A long CV with 10+ roles and full descriptions runs ~4-5k tokens of JSON.
        maxOutputTokens: 8192,
        jsonOutput: true,
    },
    autofill_fill: {
        // Slight variation reads more naturally in drafted open answers; facts are pinned by the prompt.
        temperature: 0.2,
        // One batch = up to 25 fields; drafted open answers (~250 tokens each) dominate.
        maxOutputTokens: 16384,
        jsonOutput: true,
    },
};

function envThinkingBudget(): number {
    const raw = parseInt(process.env.AI_CAREER_THINKING_BUDGET || '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

export function getGeminiProfile(operation: AiOperation): GeminiProfile {
    const profile = PROFILES[operation];
    // Read at call time, not module load, so the budget can be tuned (and swept) without a
    // restart. Only career_path_analysis opts in; everything else stays at 0.
    if (operation === 'career_path_analysis') {
        return { ...profile, thinkingBudget: envThinkingBudget() };
    }
    return profile;
}

function isGemini25Model(model: string): boolean {
    return /gemini-2\.5/i.test(model);
}

export function buildGenerationConfig(
    operation: AiOperation,
    options?: { model?: string; webDiscoveryPhase?: WebDiscoveryPhase },
): Record<string, unknown> {
    const { temperature, maxOutputTokens, thinkingBudget, jsonOutput } =
        getGeminiProfile(operation);
    const config: Record<string, unknown> = { temperature, maxOutputTokens };
    const plainWebSearch =
        operation === 'jobs_web_discovery' &&
        options?.webDiscoveryPhase === 'search';
    const plainWebExtraction =
        operation === 'jobs_web_discovery' &&
        options?.webDiscoveryPhase === 'extract';
    if (jsonOutput && !plainWebSearch && !plainWebExtraction) {
        config.responseMimeType = 'application/json';
    }
    if (operation === 'jobs_web_discovery') {
        if (options?.model && !supportsStructuredWebDiscovery(options.model)) {
            throw new Error('Web discovery requires a structured-tool-capable Gemini model');
        }
        if (plainWebSearch) {
            // Search discovery needs native grounding, not a schema-only answer.
            config.maxOutputTokens = 1536;
        } else if (!plainWebExtraction) {
            config.responseJsonSchema = WEB_DISCOVERY_RESPONSE_SCHEMA;
        }
    }

    // Gemini 2.5 defaults to dynamic thinking — pin it per operation rather than leaving it
    // dynamic, so cost is predictable. Default stays 0 (disabled); only profiles that opt in
    // by setting thinkingBudget pay for it.
    if (options?.model && isGemini25Model(options.model)) {
        config.thinkingConfig = { thinkingBudget: thinkingBudget ?? 0 };
    }

    return config;
}
