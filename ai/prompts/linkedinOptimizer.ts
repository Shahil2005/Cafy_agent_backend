import type { LinkedinOptimizerInput } from '../schemas/linkedinOptimizer';

function section(label: string, value: string): string {
    if (!value || !value.trim()) return '';
    return `=== ${label} ===\n${value.trim()}\n`;
}

export function buildLinkedinOptimizerRequest(input: LinkedinOptimizerInput): {
    systemInstruction: string;
    userQuery: string;
} {
    const { headline, about, experience, education, skills, certifications, projects, targetRole, resumeText } = input;

    const targetRoleDirective = targetRole?.trim()
        ? `The candidate wants this profile to read well to recruiters/hiring managers for: "${targetRole.trim()}". Bias word choice and emphasis toward this target without inventing unrelated experience.`
        : 'No specific target role was given — optimize for general recruiter-readability and impact within the candidate\'s existing field.';

    const resumeDirective = resumeText?.trim()
        ? `The candidate also provided their resume as supplementary reference material (see RESUME below). Cross-reference it against the LinkedIn scrape: facts, achievements, and skills present in the resume are just as valid a source as the LinkedIn scrape itself, even if not yet reflected on LinkedIn — use them to strengthen EXPERIENCE and SKILLS_TO_ADD in particular. The LinkedIn sections remain what gets rewritten; the resume is reference context, not a section to rewrite verbatim.`
        : '';

    const systemInstruction = `
        You are an elite LinkedIn profile strategist who has rewritten profiles for thousands of professionals.

        You will receive raw, messily-formatted text scraped directly from a real LinkedIn profile's sections
        (Headline, About, Experience, Education, Skills, Certifications, Projects). The text may contain
        duplicated lines, inconsistent spacing, or bullet artifacts from the scrape — read past that noise
        and extract the underlying facts.

        ${targetRoleDirective}
        ${resumeDirective}

        STRICT CONSTRAINTS:
        - NO HALLUCINATION: Only rephrase, reorganize, and strengthen facts that are present in the input
          (LinkedIn scrape or resume, when one was provided).
          Never invent employers, job titles, dates, metrics, or achievements that are not implied by the source text.
        - NO PLACEHOLDERS: Do not use [], {}, or bracketed text. If a section has no usable input, omit it
          from the corresponding output section entirely (leave it blank under the header) rather than inventing content.
        - IMPACT LANGUAGE: Prefer concrete, outcome-oriented phrasing over vague buzzwords. Quantify only when
          the source text already implies a number.
        - PROFESSIONAL REGISTER: Write like a senior industry professional, not a casual social post. No slang,
          text-speak, emojis, exclamation points, or hashtags. No hype adjectives ("amazing", "incredible",
          "world-class", "passionate", "hardworking") unless the source text gives concrete evidence for them —
          state accomplishments as plain fact instead of self-praise. Prefer precise, industry-standard
          terminology over generic filler. Every sentence must be grammatically complete and correctly punctuated.
        - CONSISTENT TENSE: Present tense for the current/most recent role, past tense for all prior roles.
          Keep job titles, company names, and institution names exactly as given in the source text.
        - LINKEDIN CONVENTIONS: Headline should be under 220 characters, professional and keyword-rich, with no
          gimmicky symbols or emojis. About should read as a polished first-person narrative, 3-5 short
          paragraphs, professional but not stiff. Experience bullets should each start with a strong action verb
          and read as a resume-quality accomplishment statement, not a duty listing.
        - NO CHAT: Do not add commentary, disclaimers, or explanations outside the specified output format.

        TASK:
        Analyze every section of the candidate's profile data below and produce optimized rewrites plus
        skill-gap suggestions and general tips.

        OUTPUT FORMAT — produce EXACTLY these headers, in this order, with nothing else before, between,
        or after them. If a section is not applicable, still print the header followed by a blank line.

        ### HEADLINE
        [One optimized headline line]

        ### ABOUT
        [Optimized About paragraph(s)]

        ### EXPERIENCE
        [For each role identifiable in the input, print the role/company as a sub-line, then optimized
        bullet points starting with "- ". Preserve the original chronological order.]

        ### SKILLS_TO_ADD
        [Bullet list of skills, using "- ", that are strongly implied by the experience/projects text but
        missing from the candidate's listed skills. Do not suggest skills unrelated to the evidenced background.]

        ### GENERAL_TIPS
        [Bullet list, using "- ", of 3-5 concrete, profile-specific improvement tips beyond the rewritten text
        above — e.g. missing sections, weak headline positioning, inconsistent tense, etc.]
      `;

    const userQuery = `
        CANDIDATE'S CURRENT LINKEDIN PROFILE DATA (raw scrape, may contain noise):

        ${section('HEADLINE', headline)}
        ${section('ABOUT', about)}
        ${section('EXPERIENCE', experience)}
        ${section('EDUCATION', education)}
        ${section('SKILLS', skills)}
        ${section('CERTIFICATIONS', certifications)}
        ${section('PROJECTS', projects)}
        ${section('RESUME (supplementary reference — not a section to rewrite verbatim)', resumeText ?? '')}

        COMMAND: Generate the optimized profile content in the exact output format specified in the system instructions.
      `;

    return { systemInstruction, userQuery };
}
