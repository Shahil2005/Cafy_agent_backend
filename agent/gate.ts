import { reviewJobChatMessage } from '../jobs-portal/chatPolicy';

export type GateResult =
    | { allowed: true; caution?: 'personal_legal' }
    | { allowed: false; reason: string; message: string };

/**
 * Runs before any AI call. Hard blocks are enforced here (injection, fabrication, off-topic,
 * abuse); everything else goes to the agent, which understands any wording instead of the old
 * pattern router.
 *
 * Questions about the user's own visa or legal situation ("Can I switch to a Skilled Worker
 * visa?") are NOT blocked: the shared policy blocks them for the old chat, but the agent answers
 * them from GOV.UK passages with a caution, and never gives a personal verdict.
 */
export function gateMessage(message: string): GateResult {
    const decision = reviewJobChatMessage(message);
    if (decision.decision === 'blocked') {
        if (decision.reason === 'personal_legal_determination') return { allowed: true, caution: 'personal_legal' };
        return { allowed: false, reason: decision.reason, message: decision.message };
    }
    return { allowed: true };
}
