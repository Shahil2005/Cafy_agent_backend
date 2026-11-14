/**
 * Detects questions about the user's OWN CV or background, decided by code rather than the model,
 * so the CV picker reliably appears when no CV is chosen. General questions ("what do data
 * analysts do?") do not match and are answered without a CV.
 */
const OWN_CV =
    /\bmy\s+(?:[a-z-]+\s+){0,2}(?:cv|c\.v\.?|resume|résumé|profile|experience|skills?|background|qualifications?|education|degree|projects?|work history|employment history|career history|achievements?|strengths?|weaknesses?|certifications?|internships?|jobs? history|portfolio)\b/i;
const SELF_ASSESSMENT =
    // Not "how do I become an analyst with no experience": that is general advice.
    /(?<!\bhow\s)\b(?:do|have|did|am|can|could|should|would|will)\s+i\b[^?.!]{0,60}\b(?:experience|skills?|qualified|qualifications?|suitable|eligible for (?:the )?role|a good fit|fit for|know|years|enough)\b/i;
/** "How many years of experience do I have?", "What can I offer?" (but not "do I have to…"). */
const ABOUT_MY_PROFILE = /\b(?:do|did|can|could)\s+i\s+(?:have|got|know|bring|offer|possess)\b(?!\s+to\b)/i;
const CV_ACTION =
    /\b(?:summari[sz]e|review|analy[sz]e|check|improve|rate|score|rewrite|update|tailor|read)\b[^?.!]{0,30}\b(?:my|the|this)\s+(?:cv|resume|résumé)\b/i;
const ABOUT_ME = /\b(?:(?:match(?:es|ing)?|suit(?:s|ing|able for)?|fit(?:s|ting)?|right for|good for|best for|recommended for)\s+me|for me\b[^?.!]{0,20}\b(?:jobs?|roles?)|about me|based on me|for someone like me|from my (?:cv|resume)|in my (?:cv|resume)|on my (?:cv|resume))\b/i;

/** "Jobs for my CV", "roles that suit me", "find me a job": real jobs chosen by the CV, with no role named. */
const JOBS_FOR_ME = new RegExp(
    [
        '\\b(?:jobs?|roles?|vacanc(?:y|ies)|openings?|positions?)\\b[^?.!]{0,30}\\b(?:for|match(?:es|ing)?|suit(?:s|ing|able for)?|fit(?:s|ting)?|based on|from|with)\\s+(?:me\\b|my\\s+(?:cv|c\\.v\\.?|resume|résumé|profile|skills?|experience|background))',
        '^\\s*(?:please\\s+)?(?:find|show|give|get)\\s+me\\s+(?:some\\s+|a\\s+|any\\s+)?(?:good\\s+|suitable\\s+)?(?:jobs?|roles?)\\s*(?:please\\s*)?[?.!]?\\s*$',
    ].join('|'),
    'i',
);

export function isJobsForMe(message: string): boolean {
    return JOBS_FOR_ME.test(message);
}

export function isAboutOwnCv(message: string): boolean {
    return isJobsForMe(message) || OWN_CV.test(message) || SELF_ASSESSMENT.test(message) || ABOUT_MY_PROFILE.test(message) || CV_ACTION.test(message) || ABOUT_ME.test(message);
}

/** "Summarise my CV", "what's in my CV", "show my profile": the CV card is worth showing again. */
const CV_SUMMARY =
    /\b(?:summar(?:y|i[sz]e)|overview|review|show|what(?:'s| is) in|go through|describe|outline)\b[^?.!]{0,30}\b(?:my\s+)?(?:cv|resume|résumé|profile)\b/i;

export function isCvSummaryRequest(message: string): boolean {
    return CV_SUMMARY.test(message);
}
