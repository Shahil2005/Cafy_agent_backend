export function getCoverLetterGoalDirective(goal: string): string {
    switch (goal) {
        case 'Referral Introduction':
            return 'Write as a referral introduction or referral request, not a standard application. Mention referral intent in the opening paragraph.';
        case 'Networking Follow-up':
            return 'Write as a follow-up to a networking interaction and reference the prior connection.';
        case 'Speculative / Cold Pitch':
            return 'Write as a speculative outreach for potential fit, not tied to a specific application.';
        case 'Internship Inquiry':
            return 'Write as an internship inquiry focusing on learning goals and fit.';
        case 'Standard Job Application':
        default:
            return 'Write as a direct application for the role.';
    }
}

export function buildStrategyContext(tone: string, focusMode: string, extraContext: string): string {
    return `
        CRITICAL OPERATIONAL PARAMETERS:
        - TONE: ${tone} (Adjust vocabulary and sentence structure accordingly)
        - FOCUS: ${focusMode} (Prioritize these aspects in the narrative)
        - USER EXTRA INSTRUCTIONS: "${extraContext}" (Overrides default behavior if conflicting)
        - DETERMINISM PROTOCOL: You must produce the EXACT same output for the same input. No variations.
        - ZERO PLACEHOLDER MANDATE: Absolutely NO square brackets (e.g., [Date]), double braces, or generic placeholders.
      `;
}

export function buildIdentityContext(senderName: string, senderContactInfo: string): string {
    return `
        SENDER IDENTITY (To be used for Sign-off/Header):
        - NAME: ${senderName}
        - CONTACT: ${senderContactInfo}
        - CRITICAL SIGNATURE RULE: You MUST use a double newline between the Name and Contact.
          Example:
          Sincerely,
          
          ${senderName}
          
          ${senderContactInfo}
      `;
}

export function formatUkDate(): string {
    return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
