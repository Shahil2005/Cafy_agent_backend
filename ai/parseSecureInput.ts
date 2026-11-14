import type { AiOperation } from '../billing/aiOperations';
import { resolveAiOperation } from '../billing/aiOperations';
import { commCoverLetterInputSchema } from './schemas/commCoverLetter';
import { commEmailInputSchema } from './schemas/commEmail';
import type { SecureAiInput } from './buildRequest';
const LEGACY_BODY_KEYS = [
    'systemInstruction',
    'contents',
    'generationConfig',
    'tools',
] as const;

function hasLegacyGeminiFields(body: Record<string, unknown>): boolean {
    return LEGACY_BODY_KEYS.some((key) => body[key] !== undefined);
}

export function parseSecureInput(
    body: Record<string, unknown>,
):
    | {
          ok: true;
          data: Extract<
              SecureAiInput,
              { operation: 'comm_cover_letter' | 'comm_email' }
          >;
      }
    | { ok: false; error: string; message: string; details?: unknown } {
    const operation = resolveAiOperation(body);
    if (!operation) {
        return {
            ok: false,
            error: 'INVALID_AI_OPERATION',
            message:
                'Missing or invalid operation. Use: comm_cover_letter or comm_email.',
        };
    }

    if (hasLegacyGeminiFields(body)) {
        return {
            ok: false,
            error: 'LEGACY_FIELDS_NOT_ALLOWED',
            message:
                'Send only operation and input. Fields like systemInstruction and contents are not accepted here.',
        };
    }

    if (body.input === undefined || body.input === null) {
        return {
            ok: false,
            error: 'INVALID_INPUT',
            message: 'Missing input object',
        };
    }

    switch (operation) {
        case 'comm_cover_letter': {
            const parsed = commCoverLetterInputSchema.safeParse(body.input);
            if (!parsed.success) {
                return {
                    ok: false,
                    error: 'INVALID_INPUT',
                    message: 'Invalid comm_cover_letter input',
                    details: parsed.error.flatten(),
                };
            }
            return { ok: true, data: { operation, input: parsed.data } };
        }
        case 'comm_email': {
            const parsed = commEmailInputSchema.safeParse(body.input);
            if (!parsed.success) {
                return {
                    ok: false,
                    error: 'INVALID_INPUT',
                    message: 'Invalid comm_email input',
                    details: parsed.error.flatten(),
                };
            }
            return { ok: true, data: { operation, input: parsed.data } };
        }
        case 'career_path_analysis': {
            return {
                ok: false,
                error: 'DIRECT_ROUTE_REQUIRED',
                message:
                    'career_path_analysis requests must go through the /api/ai/career-analysis endpoint directly.',
            };
        }
        case 'jobs_cv_profile':
        case 'jobs_cv_fit':
        case 'jobs_cv_roles': {
            return { ok: false, error: 'DIRECT_ROUTE_REQUIRED',
                message: `${operation} is only available via /api/jobs-portal/career-matches.` };
        }
        case 'jobs_search_chat':
        case 'jobs_web_discovery': {
            return {
                ok: false,
                error: 'DIRECT_ROUTE_REQUIRED',
                message: `${operation} is only available via /api/jobs-portal/chat.`,
            };
        }
        case 'linkedin_optimizer': {
            // Not exposed via the generic /api/ai/generate endpoint — use
            // POST /api/extension/linkedin-optimizer instead.
            return {
                ok: false,
                error: 'INVALID_AI_OPERATION',
                message:
                    'linkedin_optimizer is only available via /api/extension/linkedin-optimizer.',
            };
        }
        case 'agent_turn':
        case 'agent_cv_profile':
        case 'agent_job_fit':
        case 'agent_cv_tailor': {
            return {
                ok: false,
                error: 'DIRECT_ROUTE_REQUIRED',
                message: `${operation} is only available via /api/agent/*.`,
            };
        }
        case 'autofill_profile':
        case 'autofill_fill': {
            return {
                ok: false,
                error: 'INVALID_AI_OPERATION',
                message: `${operation} is only available via /api/extension/autofill/*.`,
            };
        }
        default: {
            const _op: never = operation;
            return {
                ok: false,
                error: 'INVALID_AI_OPERATION',
                message: `Unhandled operation: ${_op}`,
            };
        }
    }
}
