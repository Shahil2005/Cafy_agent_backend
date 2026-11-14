import { chatSearchSchema, interpretJobChatRules, type ChatSearch } from './chatIntent';
import { reviewJobChatMessage } from './chatPolicy';

export interface CareerMatchConversationDecision {
    action: 'search' | 'clarify' | 'advice' | 'more' | 'retry';
    /** Deterministic interpretation of the user's literal criteria, never model suggestions. */
    search?: ChatSearch;
    message?: string;
}

const ROLE_QUESTION =
    'Which job title would you like to explore? Tell me the role you want, and I’ll use your CV to compare the actual adverts. I’ll keep your other preferences.';
const REFINE_QUESTION =
    'Tell me the job title, location or preference you want to change, or say “next five” for more matches.';
const MORE =
    /^(?:please\s+)?(?:only\s+)?(?:(?:(?:i\s+)?(?:want|need)(?:\s+to\s+see)?|(?:can|could|would)\s+you\s+(?:show|find|give|load)|show|find|give|load)(?:\s+me)?\s+)?(?:(?:(?:the\s+)?next|another)(?:\s+(?:five|5))?(?:\s+(?:results|jobs|roles|matches|listings|page))?|(?:(?:five|5)\s+)?more(?:\s+(?:results|jobs|roles|matches|listings|like these|like this))?|more\s+(?:five|5)(?:\s+(?:jobs|roles|matches))?|continue|same again|page\s+\d+)(?:\s+please)?[.!?\s]*$/i;
const RETRY =
    /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:retry(?:\s+(?:this|the|that|my))?(?:\s+(?:search|shortlist|request))?|try(?:\s+(?:that|it|this))?\s+again|(?:search|check)(?:\s+(?:that|it|this))?\s+again)(?:\s+please)?[.!?\s]*$/i;

/**
 * A short answer to an explicit request for a title is a literal search term,
 * not a claim that the CV qualifies its owner for that profession. This keeps
 * uncommon occupations usable without inferring a profession from CV skills.
 */
function isLiteralRoleAnswer(message: string): boolean {
    return (
        message.length <= 100 &&
        message.split(/\s+/).length <= 10 &&
        /^[\p{L}][\p{L}\p{M}\s&'’/()-]*[\p{L}\p{M})]$/u.test(message) &&
        !/^(?:i|we|you|my|our|his|her|their|it|this|that|these|those|there|here|yes|no|maybe|anything|everything|nothing|something|whatever|not|unsure|idk|same|more|next|continue|retry|again|try|check|change|switch|stop|cancel|wait|thanks|thank|hello|hi|help|please|tell|explain|write|create|make|show|give|find|search|ignore|delete|update|remove|insert|drop|read|print|reveal|dump|export|run|execute|fetch|open|download|upload|activate|send|call|connect|process|use|how|why|what|where|when|who|can|could|would|should|do|does|is|are)\b/i.test(
            message,
        )
    );
}

function normalizedRefinement(message: string): string {
    // The legacy parser would leave “UK” behind as a new occupation here.
    return message
        .replace(/\b(?:anywhere|everywhere)\s+(?:(?:in|across)\s+)?(?:the\s+)?(?:UK|United Kingdom|Britain)\b/gi, 'anywhere')
        .replace(/^I (?:want|would like|need) to work (?=(?:in|near|around)\s)/i, '')
        .replace(/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?help me\s+(?=(?:find|search|look for|browse|discover)\b)/i, '')
        .replace(/^I(?:\s+(?:want|need|would like)|['’]d like)\s+(?:you\s+)?to\s+(?=(?:find|search|look for|browse|discover)\b)/i, '')
        .replace(/^(?:please\s+)?(?:change|switch)(?:\s+(?:the|my)\s+(?:role|job title))?\s+to\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Pure, provider-free routing for the CV conversation. The reviewed career
 * policy runs before parsing, so unrelated questions and unsafe instructions
 * cannot become occupation keywords. No CV analysis is repeated here.
 */
export function interpretCareerMatchConversation(
    message: string,
    previousSearch: ChatSearch,
    options: { needsRole?: boolean } = {},
): CareerMatchConversationDecision {
    const previous = chatSearchSchema.parse(previousSearch);
    const policy = reviewJobChatMessage(message, { previousSearch: previous, history: [] });
    if (policy.decision === 'blocked' || policy.reason === 'invalid_input')
        return { action: 'clarify', search: previous, message: policy.message };
    const value = message.normalize('NFKC').replace(/[\u200b-\u200f\ufeff]/g, '').trim();
    if (MORE.test(value))
        return options.needsRole
            ? { action: 'clarify', search: previous, message: ROLE_QUESTION }
            : { action: 'more', search: previous };
    if (RETRY.test(value))
        return options.needsRole
            ? { action: 'clarify', search: previous, message: ROLE_QUESTION }
            : { action: 'retry', search: previous };
    if (policy.reason === 'greeting')
        return { action: 'clarify', search: previous, message: options.needsRole ? ROLE_QUESTION : REFINE_QUESTION };

    const input = normalizedRefinement(value);
    const normalizedPolicy = input === value ? policy : reviewJobChatMessage(input, { previousSearch: previous, history: [] });
    if (policy.decision === 'career-advice' && normalizedPolicy.decision !== 'career-search')
        return { action: 'advice', search: previous };
    const parsed = interpretJobChatRules({ message: input, search: previous, history: [] });
    // Preserve a literal leading dotted identifier that compact() strips as
    // punctuation; this does not add a token or infer a different occupation.
    const dottedWord = /(?:^|\s)\.([\p{L}][\p{L}\p{N}]*)\b/u.exec(input)?.[1];
    if (dottedWord && parsed.search.role.startsWith(`${dottedWord} `))
        parsed.search.role = `.${parsed.search.role}`;
    if (parsed.search.unsupported.length)
        return { action: 'clarify', search: parsed.search, message: parsed.clarification || REFINE_QUESTION };
    // Negations the general parser could not represent must not become positive
    // role/location keywords. Explicit broadening is already consumed by it.
    if (/\b(?:not|no|without|excluding|except|anything but)\b/i.test(`${parsed.search.role} ${parsed.search.where}`) &&
        (parsed.search.role !== previous.role || parsed.search.where !== previous.where))
        return { action: 'clarify', search: previous,
            message: 'I cannot reliably apply that exclusion. Tell me the roles or locations to include; I’ll keep your current preferences until you choose.' };

    const isFilterRefinement =
        parsed.search.role === previous.role && JSON.stringify(parsed.search) !== JSON.stringify(previous);
    const isRoleAnswer = isLiteralRoleAnswer(input);
    if (normalizedPolicy.decision !== 'career-search' && !isFilterRefinement && !isRoleAnswer)
        return { action: 'clarify', search: previous, message: options.needsRole ? ROLE_QUESTION : REFINE_QUESTION };
    if (parsed.requiresClarification)
        return { action: 'clarify', search: parsed.search, message: parsed.clarification || ROLE_QUESTION };
    if (options.needsRole && !parsed.search.role)
        return { action: 'clarify', search: parsed.search, message: ROLE_QUESTION };
    return { action: 'search', search: parsed.search };
}
