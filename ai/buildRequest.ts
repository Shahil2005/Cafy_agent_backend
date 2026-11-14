import type { CommCoverLetterInput } from './schemas/commCoverLetter';
import type { CommEmailInput } from './schemas/commEmail';
import type { LinkedinOptimizerInput } from './schemas/linkedinOptimizer';
import { buildCommCoverLetterRequest } from './prompts/commCoverLetter';
import { buildCommEmailRequest } from './prompts/commEmail';
import { buildLinkedinOptimizerRequest } from './prompts/linkedinOptimizer';
import type { GeminiRequestPayload } from './geminiCore';

export type SecureAiInput =
    | { operation: 'comm_cover_letter'; input: CommCoverLetterInput }
    | { operation: 'comm_email'; input: CommEmailInput }
    | { operation: 'linkedin_optimizer'; input: LinkedinOptimizerInput };

function toGeminiPayload(systemInstruction: string, userQuery: string): GeminiRequestPayload {
    return {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: [{ text: userQuery }] }],
    };
}

export function buildSecureGeminiRequest(secure: SecureAiInput): GeminiRequestPayload {
    switch (secure.operation) {
        case 'comm_cover_letter': {
            const { systemInstruction, userQuery } = buildCommCoverLetterRequest(secure.input);
            return toGeminiPayload(systemInstruction, userQuery);
        }
        case 'comm_email': {
            const { systemInstruction, userQuery } = buildCommEmailRequest(secure.input);
            return toGeminiPayload(systemInstruction, userQuery);
        }
        case 'linkedin_optimizer': {
            const { systemInstruction, userQuery } = buildLinkedinOptimizerRequest(secure.input);
            return toGeminiPayload(systemInstruction, userQuery);
        }
        default: {
            const _exhaustive: never = secure;
            throw new Error(`Unhandled operation: ${(_exhaustive as SecureAiInput).operation}`);
        }
    }
}

