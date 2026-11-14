import type { CommEmailInput } from '../schemas/commEmail';
import { buildIdentityContext, buildStrategyContext } from './commHelpers';

export function buildCommEmailRequest(input: CommEmailInput): {
    systemInstruction: string;
    userQuery: string;
} {
    const {
        emailType,
        tone,
        focusMode,
        extraContext,
        senderName,
        senderContactInfo,
        candidateData,
        job,
    } = input;

    const strategyContext = buildStrategyContext(tone, focusMode, extraContext ?? '');
    const identityContext = buildIdentityContext(senderName, senderContactInfo);
    const baseContent =
        candidateData || 'No source CV selected. Focus on the JD and identity.';
    const jobContext = `Role: ${job.role}, Company: ${job.company}. Job Description: "${job.jobDescription || ''}"`;

    const systemInstruction = `
          You are an Expert Career Advocate & Networker. Your goal is to draft high-conversion outreach emails.
          
          
          ${strategyContext}
          ${identityContext}
          
          === CRITICAL IMMUTABLE FORMATTING RULES ===
          The Layout Structure below is ABSOLUTE. It must NEVER change.
          1. NO INDENTATION: All text must be flush left. No tabs, no spaces at start of lines.
          2. SUBJECT LINE: Must be the very first line, bolded.
          3. PLACEHOLDERS: NEVER use brackets like [Insert Name]. Use standard tokens like "{{NAME}}" or fallback terms like "Hiring Manager" directly in the text.
          ===========================================

          STRICT CONSTRAINTS:
          - CONCISENESS: Emails must be short, punchy, and scannable. Under 150 words preferred.
          - NO HALLUCINATION: Use ONLY real achievements.
          - PARAMETER ADHERENCE: Tone ("${tone}") affects the voice, not the format.
          
          TASK:
          1. ANALYZE the Goal (usually networking or application follow-up).
          2. WRITE the email followed by the strategy analysis.

          OUTPUT STRUCTURE:

          **Subject: {{ENGAGING_SUBJECT_LINE}}**

          Hi {{NAME}}, (If name unknown, use "Hiring Manager" or "Team")

          [Email Body - Short, punchy paragraphs. Flush left.]

          Best,

          [Sender Name]

          @@SPLIT@@

          PART 2: STRATEGY
          * [Why this subject line works]
          * [Key value prop used]
        `;

    const userQuery = `
          INTENT: ${emailType}
          PRIMARY GOAL / CONTEXT (DO NOT IGNORE): ${emailType}
          TARGET CONTEXT: ${jobContext}
          CANDIDATE DATA: "${baseContent}"
          
          GENERATE NOW. Tone: ${tone}. Focus: ${focusMode}.
        `;

    return { systemInstruction, userQuery };
}
