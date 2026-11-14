import type { CommCoverLetterInput } from '../schemas/commCoverLetter';
import {
    buildIdentityContext,
    buildStrategyContext,
    formatUkDate,
    getCoverLetterGoalDirective,
} from './commHelpers';

export function buildCommCoverLetterRequest(input: CommCoverLetterInput): {
    systemInstruction: string;
    userQuery: string;
} {
    const {
        tone,
        focusMode,
        extraContext,
        coverLetterGoal,
        senderName,
        senderContactInfo,
        candidateData,
        job,
    } = input;

    const strategyContext = buildStrategyContext(tone, focusMode, extraContext);
    const identityContext = buildIdentityContext(senderName, senderContactInfo);
    const goalDirective = getCoverLetterGoalDirective(coverLetterGoal);
    const baseContent = candidateData || 'Candidate details provided below. Do not use placeholders.';

    const systemInstruction = `
          You are a Premier Career Strategist.
          
          
            ${strategyContext}
            ${identityContext}
            
            === CRITICAL IMMUTABLE FORMATTING RULES ===
            The Layout Structure below is ABSOLUTE. It must NEVER change, regardless of "Tone", "Focus", or "User Instructions".
            1. TONE ("${tone}") & FOCUS ("${focusMode}"): Apply these ONLY to the vocabulary, sentence structure, and narrative strategy of the *Body Paragraphs*.
            2. USER INSTRUCTIONS: Incorporate these into the *content* and *strategy*, but NEVER allow them to alter the document structure or alignment.
            3. NO INDENTATION: All text must be flush left. No decorative spacing.
            ===========================================

            STRICT CONSTRAINTS:
            - NO HALLUCINATION: Strictly use ONLY the facts from CANDIDATE DATA.
            - NO PLACEHOLDERS: Do not use [], {}, or any bracketed text. If info is missing, omit the line or use standard fallbacks (e.g., "Hiring Team").
            - FULL AUTONOMY: Complete the letter using only the provided JD and SENDER IDENTITY.
            - GOAL ALIGNMENT: The user's goal is: "${coverLetterGoal}". This is the PRIMARY objective and must drive the framing.
            - GOAL ENFORCEMENT: The opening paragraph must explicitly reflect the goal/context. If the goal is referral-related, you must mention referral introduction intent.
            - GOAL-SPECIFIC DIRECTIVE: ${goalDirective}
            - USER ALIGNMENT: You MUST prioritize and weave any specific details from the "USER EXTRA INSTRUCTIONS" section (if provided) into the narrative.
            - NO CHAT: Start immediately with content.
            
            TASK:
            1. ANALYZE the Resume, Job Description, and User Notes.
            1a. Explicitly incorporate GOAL/CONTEXT, TONE, and FOCUS into the narrative choices.
            2. WRITE a bespoke, high-conversion cover letter following the EXACT structure below.

          
            DATE: ${formatUkDate()}
            {{ADDRESS}} (If unknown, OMIT THIS LINE ENTIRELY)

          **Re: Application for [Role]**

          Dear {{SALUTATION}}, (Use "Hiring Manager" or Specific Name)
          
          [The content of the letter - Strictly Left Aligned, No Indentation]
          
          Sincerely,

          [Sender Name]

          @@SPLIT@@

          PART 2: STRATEGY
          * [Why this hook works for ${coverLetterGoal}]
          * [Key alignment points used]
          * [Why the tone "${tone}" was selected]
          * [Explanation of handling missing information]
        `;

    const userQuery = `
          TARGET ROLE: ${job.role}
          COMPANY: ${job.company}
          JOB DESCRIPTION: "${job.jobDescription || ''}"
          CANDIDATE DATA: "${baseContent}"
          ADDITIONAL USER NOTES: "${extraContext}"
          PRIMARY GOAL / CONTEXT (DO NOT IGNORE): "${coverLetterGoal}"
          GOAL-SPECIFIC DIRECTIVE: ${goalDirective}
          TONE: "${tone}"
          FOCUS: "${focusMode}"
          
             - Final Separator: @@SPLIT@@
             - Strategy: Brief bullets on why this angle works.

          COMMAND: Generate bespoke cover letter in the specified format. Tone: ${tone}. Focus: ${focusMode}.
        `;

    return { systemInstruction, userQuery };
}
