import type { ChatSearch } from './chatIntent';
import { normalizeChatWhere } from './chatIntent';
import { PART_TIME_UK_CITIES } from './partTimeCities';

export interface JobChatPolicyContext {
    previousSearch?: Partial<ChatSearch>;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface JobChatPolicyDecision {
    decision: 'career-search' | 'career-advice' | 'blocked' | 'clarify';
    reason:
        | 'prompt_injection'
        | 'fabrication_request'
        | 'personal_legal_determination'
        | 'off_topic_request'
        | 'abuse'
        | 'greeting'
        | 'career_advice'
        | 'career_search'
        | 'search_refinement'
        | 'unclear'
        | 'invalid_input';
    /** Only fixed scope/clarification text. Career replies are supplied by the grounded service. */
    message: string;
}

const SCOPE_MESSAGE =
    'I can help with finding jobs, CVs, applications and interviews. Ask me a career question or tell me the role, employer or location you want to search.';
const HONEST_APPLICATION_MESSAGE =
    'I can help present your real experience clearly and identify skills to develop. I cannot invent qualifications, employment, achievements or job listings.';
const LEGAL_MESSAGE =
    'I can help find jobs and explain employer sponsorship evidence. I cannot determine your personal immigration eligibility or make a legal decision. Check official guidance or speak to a qualified adviser for your circumstances.';

const CAREER_WORDS =
    /\b(?:jobs?|careers?|vacanc(?:y|ies)|employment|employers?|civil[ -]*service|recruit(?:er|ment|ing)?|cv|resum[eé]s?|cover letters?|supporting statements?|application(?:s| forms?)?|interviews?|internships?|apprenticeships?|placements?|job search|job hunt|professional portfolio|linkedin profile)\b/i;
const ROLE_WORDS =
    /\b(?:analysts?|developers?|engineers?|programmers?|designers?|researchers?|scientists?|nurses?|doctors?|physicians?|pharmacists?|therapists?|teachers?|lecturers?|tutors?|accountants?|auditors?|solicitors?|paralegals?|chefs?|cooks?|baristas?|waiters?|waitresses|receptionists?|administrators?|managers?|consultants?|technicians?|electricians?|plumbers?|mechanics?|drivers?|cleaners?|cashiers?|care assistants?|healthcare assistants?|support workers?|social workers?|security guards?|warehouse operatives?|retail assistants?|sales assistants?|customer service advisors?|data scientists?)\b/i;
const SEARCH_WORDS = /\b(?:find|show|search|look for|looking for|list|browse|discover|fetch|get me)\b/i;
const JOB_WORDS =
    /\b(?:jobs?|roles?|vacanc(?:y|ies)|positions?|opportunities|internships?|apprenticeships?|placements?)\b/i;
const ADVICE_FOLLOW_UP =
    /^(?:tell me more|explain (?:that|it)|what next|how do i do that|give me an example)[.!?\s]*$/i;

const INSTRUCTION_OVERRIDE =
    /(?:^|[,.;:!?\n]\s*|\b(?:and|then|also|now)\s+)(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+|you\s+(?:must|should|have to)\s+)?(?:please\s+)?(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|previous|prior|above|earlier|system|developer|safety|security|career|job[- ]only|existing)\s+){0,5}(?:instructions?|rules?|polic(?:y|ies)|restrictions?|guardrails?|system prompts?|previous messages?)\b/i;
const PROMPT_DISCLOSURE =
    /\b(?:reveal|print|show|return|output|expose|give|tell)\s+(?:me\s+)?(?:(?:your|the|all|hidden|internal|original)\s+){1,3}(?:system|developer)\s+(?:prompts?|instructions?|messages?)\b|\bwhat(?: is| are|'s)\s+(?:your|the)\s+(?:hidden\s+)?(?:system|developer)\s+(?:prompts?|instructions?|messages?)\b/i;
const SECRET_DISCLOSURE =
    /\b(?:reveal|print|show|return|output|expose|dump|give me)\s+(?:(?:your|the|all|internal|server|backend|configured|environment)\s+){1,4}(?:api[ _-]?keys?|passwords?|secrets?|access tokens?|credentials?|environment variables?|process\.env)\b|\b(?:cat|read|print|dump|return|show)\s+(?:(?:the|your)\s+)?(?:\.env\b|process\.env\b)|\b(?:dump|export|download|show)\s+(?:(?:all|the|other)\s+){0,2}(?:users?\s+(?:data|records|cvs|resumes)|private\s+(?:profiles|cvs|records)|database)\b/i;
const ROLE_OVERRIDE =
    /\b(?:you are now|act as|pretend to be|role[- ]?play as)\s+(?:(?:an?|the)\s+)?(?:unrestricted|jailbroken|system administrator|developer message|system message|a different assistant)\b|(?:<\|(?:system|developer|im_start)\|>|\[\s*(?:system|developer)\s*\]|<\s*(?:system|developer)\s*>)/i;

function fabricationRequested(message: string): boolean {
    const pattern =
        /\b(?:make up|invent|fabricate|fake|falsify|forge)\s+(?:[a-z][a-z0-9&'-]*\s+){0,5}(?:experience|qualifications?|degrees?|certificates?|references?|credentials?|employment history|achievements?|accomplishments?|job offers?|job listings?|vacancies|cv|resum[eé])\b|\b(?:lie|misrepresent)\b[^.!?\n]{0,55}\b(?:cv|resum[eé]|experience|qualifications?|applications?)\b/gi;
    for (const match of message.matchAll(pattern)) {
        const before = message.slice(Math.max(0, match.index! - 60), match.index).trim();
        // Asking how to detect or avoid dishonesty is legitimate application guidance.
        if (
            /\b(?:avoid(?:ing)?|detect(?:ing)?|spot(?:ting)?|prevent(?:ing)?|without|not|never|do not|don't|dont|cannot|can't)\s*(?:(?:any|an?|the|my|our|their|ever)\s*)*$/i.test(
                before,
            )
        )
            continue;
        return true;
    }
    return (
        /\b(?:add|insert|write|claim|say|pretend)\b[^.!?\n]{0,90}\b(?:even though|although|despite|when)\b[^.!?\n]{0,60}\b(?:never|haven't|have not|don't|do not|didn't|did not)\b/i.test(
            message,
        ) && /\b(?:experience|qualifications?|degrees?|worked|employment|cv|resum[eé])\b/i.test(message)
    );
}

function personalLegalDecision(message: string): boolean {
    if (
        /\b(?:which|what)\s+soc\s+code\b[^.!?\n]{0,80}\b(?:should i|for me|my visa|this job|this role|use|eligible)\b/i.test(
            message,
        )
    )
        return true;
    const immigration = /\b(?:visa|immigration|right to work|skilled worker|graduate route|student route|ukvi)\b/i.test(
        message,
    );
    const personal =
        /\b(?:am i|are we|do i|do we|can i|can we|will i|will we|would i|would we|(?:whether|if) i (?:am|can|could|would|will))\b[^.!?\n]{0,100}\b(?:eligible|qualif\w*|legally?|allowed|permitted|work|stay|remain|switch|extend|renew|meet (?:the )?requirements)\b|\bmy\s+(?:visa|immigration status)\b[^.!?\n]{0,80}\b(?:permit|allow|eligible|qualif|legal|right to work)\w*\b/i.test(
            message,
        );
    if (immigration && personal) return true;
    return /\b(?:can i sue|should i sue|is my employer liable|is my (?:employer|boss|manager))\b[^.!?\n]{0,80}\b(?:illegal|unlawful|liable|break\w* (?:the )?law|discriminat\w*)\b/i.test(
        message,
    );
}

function explicitOffTopic(message: string): boolean {
    const recipeRequest =
        /\b(?:write|give|show|suggest|create|make)\s+(?:me\s+)?(?:(?:a|an|the|some)\s+)?(?:[a-z][a-z-]*\s+){0,4}recipes?\b/i.exec(
            message,
        );
    if (recipeRequest && !CAREER_WORDS.test(recipeRequest[0]) && !JOB_WORDS.test(recipeRequest[0])) return true;
    const patterns = [
        /\b(?:what(?:'s| is)|tell me|give me|show me|check|forecast|predict)\s+(?:(?:the|a|an|current|today'?s|tomorrow'?s)\s+){0,3}weather\b/i,
        /\b(?:write|compose|generate|tell|give|make|create)\s+(?:me\s+)?(?:(?:a|an|some|funny|short|long)\s+){0,3}(?:jokes?|poems?|songs?|recipes?|novels?|love letters?|essays?)\b/i,
        /\b(?:how (?:do|can) i|how to|teach me to|help me)\s+(?:cook|bake)\b/i,
        /\b(?:diagnose|treat|prescribe)\b[^.!?\n]{0,45}\b(?:my|me|symptoms|pain|fever|rash)\b/i,
        /\b(?:what stocks?|which stocks?|which coins?|should i invest|recommend[^.!?\n]{0,20}(?:stocks?|crypto))\b/i,
        /\b(?:football|cricket|rugby|tennis|basketball|premier league)\b[^.!?\n]{0,35}\b(?:scores?|results?|predictions?|who won|who will win)\b|\b(?:who won|who will win|predict the score)\b[^.!?\n]{0,45}\b(?:match|game|league|cup|football|cricket|rugby)\b/i,
        /\b(?:plan|book|organise|organize)\s+(?:(?:my|a|an|the|our)\s+)?(?:holiday|vacation|flight|hotel)\b/i,
        /\b(?:dating|romantic|relationship)\s+advice\b|\brejected by\s+(?:my\s+)?(?:girls?|boys?|dates?|crush)\b/i,
        /\b(?:solve|do|complete|write)\s+(?:(?:my|the|this|a|an)\s+)?(?:(?:maths?|physics|chemistry|biology|history|university|school)\s+){0,2}homework\b/i,
        /^(?:(?:what(?:'s| is)|calculate|solve)\s+)?[\d\s()+*/.^%=x-]+\??\s*$/i,
    ];
    if (patterns.some((pattern) => pattern.test(message))) return true;
    // Technical interview preparation is in scope; a standalone programming request is not.
    return (
        /^(?:please\s+)?(?:write|create|build|debug|fix)\s+(?:me\s+)?(?:a\s+)?(?:python|javascript|java|sql|react|typescript|c\+\+)\b/i.test(
            message,
        ) && !/\b(?:interview|technical assessment|coding assessment|job application|portfolio)\b/i.test(message)
    );
}

function hasCareerContext(context: JobChatPolicyContext): boolean {
    const previous = context.previousSearch;
    if (
        previous &&
        (previous.role?.trim() ||
            previous.where?.trim() ||
            previous.employer?.trim() ||
            previous.salary ||
            previous.employerScope === 'civil-service' ||
            previous.jobTypes?.length ||
            previous.levels?.length ||
            (previous.sponsorship && previous.sponsorship !== 'any') ||
            (previous.workingArrangement && previous.workingArrangement !== 'any'))
    )
        return true;
    return Boolean(context.history?.slice(-8).some((item) => item.role === 'user' && CAREER_WORDS.test(item.content)));
}

function latestSafeUserWasAdvice(context: JobChatPolicyContext): boolean {
    const history = context.history?.slice(-8) || [];
    for (let index = history.length - 1; index >= 0; index--) {
        const item = history[index]!;
        if (item.role !== 'user' || ADVICE_FOLLOW_UP.test(item.content.trim())) continue;
        const previous = reviewJobChatMessage(item.content, { previousSearch: context.previousSearch });
        if (previous.decision === 'blocked') continue;
        return previous.decision === 'career-advice';
    }
    return false;
}

function searchRefinement(message: string, context: JobChatPolicyContext): boolean {
    if (/^(?:start over|reset(?: search)?|new search)[.!]?$/i.test(message)) return true;
    if (message.length > 180) return false;
    const careerContext = hasCareerContext(context);
    const where = normalizeChatWhere(
        message.replace(/^(?:what about|how about|same (?:jobs|roles)(?: but)?|in)\s+/i, ''),
    );
    if (PART_TIME_UK_CITIES.some((city) => city.toLowerCase() === where.toLowerCase())) return true;
    return (
        /^(?:(?:only|just|make (?:it|them))\s+)?(?:fully remote|remote|hybrid|on[- ]site|full[- ]time|part[- ]time|contract|internship|junior|senior|graduate|entry[- ]level)(?:\s+only)?[.!]?$/i.test(
            message,
        ) ||
        /^(?:any (?:salary|location|employer|company|experience level|level|job type|working arrangement)|all (?:locations|cities|employers|companies|levels|job types)|anywhere|no sponsorship (?:needed|required|filter)|remove unsupported filters|ignore unsupported (?:filters|requirements))[.!]?$/i.test(
            message,
        ) ||
        /^(?:remove|clear|drop|ignore)\s+(?:the\s+)?(?:salary|location|employer|company|experience level|level|job type|working arrangement|remote|sponsorship)(?:\s+(?:filter|preference|requirement))?[.!]?$/i.test(
            message,
        ) ||
        (careerContext &&
            /^(?:at|in|near|around|for employer|with employer|employer:|company:)\s+[\p{L}\p{N}][\p{L}\p{N}\s&'.,()-]{0,100}(?:\s+instead)?[.!]?$/iu.test(
                message,
            )) ||
        /^(?:(?:salary|paying|paid|at least|at most|over|above|under|below|from|up to|between)\s+)?(?:[£€$]|GBP|EUR|USD)?\s*\d[\d,.]*\s*k?(?:\s*(?:-|to|and)\s*(?:[£€$]|GBP|EUR|USD)?\s*\d[\d,.]*\s*k?)?(?:\s*(?:per|an?|\/)\s*(?:year|annum|hour|month))?(?:\s*(?:only|instead))?[.!]?$/i.test(
            message,
        ) ||
        (careerContext &&
            /^(?:(?:show|find|give|load)\s+(?:me\s+)?)?(?:more(?:\s+(?:results|jobs|roles|listings|like these))?|next(?:\s+(?:page|results|jobs|roles))?|page\s+\d+|continue|same again)[.!]?$/i.test(
                message,
            )) ||
        (careerContext &&
            /^(?:also\s+)?(?:(?:search|include|use|check|find)(?:\s+(?:the|only)){0,2}\s+)?(?:web(?:\s+(?:search|results|jobs))?|live employer sites|employer sites|cafy(?:\s+catalogue)?|catalogue)(?:\s+(?:too|as well|only|instead))?[.!]?$/i.test(
                message,
            ))
    );
}

/**
 * Conservative server-side routing, not proof that arbitrary natural language
 * is safe or correctly understood. Unknown intent asks for clarification; the
 * search service and sourced-advice service must still validate their outputs.
 */
export function reviewJobChatMessage(message: string, context: JobChatPolicyContext = {}): JobChatPolicyDecision {
    const answer = (
        decision: JobChatPolicyDecision['decision'],
        reason: JobChatPolicyDecision['reason'],
        reply = '',
    ): JobChatPolicyDecision => ({ decision, reason, message: reply });
    if (typeof message !== 'string' || !message.trim() || message.length > 2000)
        return answer('clarify', 'invalid_input', SCOPE_MESSAGE);
    const value = message
        .normalize('NFKC')
        .replace(/[\u200b-\u200f\ufeff]/g, '')
        .replace(/[\u2018\u2019]/g, "'")
        .trim();
    if (
        INSTRUCTION_OVERRIDE.test(value) ||
        PROMPT_DISCLOSURE.test(value) ||
        SECRET_DISCLOSURE.test(value) ||
        ROLE_OVERRIDE.test(value)
    )
        return answer('blocked', 'prompt_injection', SCOPE_MESSAGE);
    if (fabricationRequested(value)) return answer('blocked', 'fabrication_request', HONEST_APPLICATION_MESSAGE);
    if (personalLegalDecision(value)) return answer('blocked', 'personal_legal_determination', LEGAL_MESSAGE);
    if (explicitOffTopic(value)) return answer('blocked', 'off_topic_request', SCOPE_MESSAGE);
    if (
        /^(?:(?:you|you're|you are)\s+)?(?:(?:a|an|so|fucking)\s+)?(?:idiot|stupid|useless|moron|fuck you|shut up)[.!?\s]*$/i.test(
            value,
        )
    )
        return answer('blocked', 'abuse', SCOPE_MESSAGE);
    if (
        /^(?:hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|how are you|are you there|who are you|what can you do|help)[!.?\s]*$/i.test(
            value,
        )
    )
        return answer('clarify', 'greeting', SCOPE_MESSAGE);
    if (ADVICE_FOLLOW_UP.test(value) && latestSafeUserWasAdvice(context))
        return answer('career-advice', 'career_advice');
    if (searchRefinement(value, context)) return answer('career-search', 'search_refinement');
    const career = CAREER_WORDS.test(value);
    const role = ROLE_WORDS.test(value);
    const question =
        /^(?:please\s+)?(?:how(?!\s+about\b)\b|why\b|what (?:should|can|could|does|do|is|are)\b|can you (?:help|explain)\b|could you (?:help|explain)\b|explain\b|help\b|advise\b|tips\b)/i.test(
            value,
        );
    const adviceSearchTarget =
        /\b(?:find|show|search|look for|list|give me)\b[^.!?\n]{0,25}\b(?:cv (?:examples?|templates?)|resume (?:examples?|templates?)|interview (?:questions?|answers?|preparation|tips|practice)|cover letter (?:examples?|templates?)|application tips?)\b/i.test(
            value,
        );
    if (!question && !adviceSearchTarget && SEARCH_WORDS.test(value) && (JOB_WORDS.test(value) || role))
        return answer('career-search', 'career_search');
    const applicationAdvice =
        /\b(?:cv|resum[eé]|cover letter|supporting statement|application form|linkedin profile|interview(?:s|ing|er)?|job applications?|career (?:path|change|advice|plan)|job search strategy|salary negotiation|networking for (?:jobs|work))\b/i.test(
            value,
        );
    const rejectionAdvice =
        /\b(?:keep getting rejected|applications? (?:are |keep getting )?rejected|no responses? to my applications?|not getting (?:any )?interviews?|keep failing interviews?)\b/i.test(
            value,
        );
    const starAdvice =
        /\bSTAR\b/.test(value) && /\b(?:explain|method|technique|answer|interview|example|what is)\b/i.test(value);
    if (
        rejectionAdvice ||
        starAdvice ||
        applicationAdvice ||
        (question && (career || role || (hasCareerContext(context) && JOB_WORDS.test(value)))) ||
        (/\bhow (?:do|can|should) i apply\b/i.test(value) && /\b(?:nhs|civil service|jobs?|roles?)\b/i.test(value))
    )
        return answer('career-advice', 'career_advice');
    if (
        (SEARCH_WORDS.test(value) && (career || role || JOB_WORDS.test(value))) ||
        (!question && value.length <= 180 && (JOB_WORDS.test(value) || role || /\bcivil[ -]*service\b/i.test(value)))
    )
        return answer('career-search', 'career_search');
    return answer('clarify', 'unclear', SCOPE_MESSAGE);
}

/**
 * An output scope check, not factual verification. Google citations, matching
 * evidence and source freshness still require independent validation.
 * Review bounded overlapping windows because the input router rejects messages
 * over 2,000 characters rather than inspecting their entire contents.
 */
export function isPermittedCareerResearchAnswer(text: string): boolean {
    if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 20_000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    )
        return false;
    const value = text
        .normalize('NFKC')
        .replace(/[\u200b-\u200f\ufeff]/g, '')
        .trim();
    if (!value || value.length > 20_000 || (!CAREER_WORDS.test(value) && !ROLE_WORDS.test(value))) return false;
    const windowSize = 2000;
    const overlap = 400;
    for (let start = 0; start < value.length; start += windowSize - overlap) {
        if (reviewJobChatMessage(value.slice(start, start + windowSize)).decision === 'blocked') return false;
    }
    return true;
}
