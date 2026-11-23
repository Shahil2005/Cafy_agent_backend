import { reviewJobChatMessage } from '../jobs-portal/chatPolicy';

export type GateResult =
    | { allowed: true; caution?: 'personal_legal' }
    | { allowed: false; reason: string; message: string };

/**
 * Reasons the shared policy blocks that the agent answers itself instead:
 * - personal_legal_determination: answered from GOV.UK passages with a caution, never a personal verdict.
 * - off_topic_request: general questions (a fact, maths, a short poem, a cooking tip, a health or money
 *   question) are answered briefly by the agent, within the limits in its prompt (no live data, no diagnosis,
 *   no investment picks, no assessed work written for them).
 * - abuse: a frustrated user gets a calm reply and another try, not a canned scope message.
 */
const ANSWERED_BY_AGENT = new Set(['off_topic_request', 'abuse']);

/**
 * Runs before any AI call. Hard blocks stay here (prompt injection, secret or prompt disclosure,
 * fabricated applications); everything else goes to the agent, which understands any wording.
 */
export function gateMessage(message: string): GateResult {
    const decision = reviewJobChatMessage(message);
    if (decision.decision === 'blocked') {
        if (decision.reason === 'personal_legal_determination') return { allowed: true, caution: 'personal_legal' };
        if (ANSWERED_BY_AGENT.has(decision.reason)) return { allowed: true };
        return { allowed: false, reason: decision.reason, message: decision.message };
    }
    return { allowed: true };
}
