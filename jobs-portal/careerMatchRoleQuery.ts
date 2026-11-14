/**
 * Broad retrieval spelling only; the career title matcher still checks the
 * original requested occupation. Split SQL terms find joined and hyphenated
 * spellings without inventing occupation synonyms or changing manual chat.
 */
export function careerRoleRetrievalQuery(role: string): string {
    return role
        .replace(/\b(front|back)[ -]?end\b/gi, '$1 end')
        .replace(/\bfull[ -]?stack\b/gi, 'full stack')
        .replace(/\breact(?:\.js|js)\b/gi, 'React')
        .replace(/\s+/g, ' ')
        .trim();
}
