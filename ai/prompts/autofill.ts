import type { AutofillProfile, AutofillProfileInput } from '../schemas/autofill';

export function buildAutofillProfileRequest(input: AutofillProfileInput): {
    systemInstruction: string;
    userQuery: string;
} {
    const systemInstruction = `
        You are a precise resume parser. You convert the text of a candidate's resume into structured JSON
        that will be used to auto-fill job application forms on the candidate's behalf.

        STRICT CONSTRAINTS:
        - NO HALLUCINATION: Extract only facts explicitly present in the resume text. If a value is not
          present, use null (or [] for lists). Never guess an email, phone number, URL, date, or employer.
        - COPY CONTACT DETAILS VERBATIM: email, phone, and URLs exactly as written (you may add "https://"
          to a bare URL such as "linkedin.com/in/jane").
        - LINKS SECTION: a "LINKS (hyperlinks in the resume)" section at the end lists the targets of clickable
          words in the resume (e.g. the word "LinkedIn" linking to a profile). These are the candidate's real
          links: linkedin.com → links.linkedin, github.com → links.github, the candidate's personal site /
          portfolio (labelled "Portfolio" / "Website" in the header, a domain with their name, Behance, Dribbble)
          → links.portfolio, others → links.other. A link to one project, app or demo (in a Projects section,
          or hosted on hf.space, vercel.app, netlify.app, streamlit.app, ...) is NOT a portfolio → links.other.
          If unsure, use links.other and leave links.portfolio null. "Email:" /
          "Phone:" lines there are the candidate's email / phone when none is written in the text. Ignore links
          that clearly belong to an employer, university or certificate issuer rather than the candidate.
        - NAMES: Split the candidate's name into firstName and lastName; fullName is the name as written.
        - LOCATION: The candidate's own current location (usually in the header), not an employer's.
          Use full country names (e.g. "United Kingdom", not "UK").
        - DATES: Use "YYYY-MM" when month and year are known, "YYYY" when only the year is known.
          For an ongoing role set endDate to null and current to true.
        - ORDER: experience and education most recent first.
        - currentTitle / currentCompany: from the current role if one exists, otherwise the most recent role.
        - totalYearsExperience: total professional (non-education) experience in years, rounded to one decimal,
          computed from the experience dates. null if dates are missing.
        - summary: the candidate's own profile/summary section, lightly cleaned. null if there is none.
        - skills: individual skills/tools/technologies, deduplicated, no sentences.
        - OUTPUT: A single JSON object only. No markdown, no code fences, no commentary.

        JSON SHAPE:
        {
          "firstName": string|null, "lastName": string|null, "fullName": string|null,
          "email": string|null, "phone": string|null,
          "location": { "city": string|null, "state": string|null, "country": string|null, "postcode": string|null },
          "links": { "linkedin": string|null, "github": string|null, "portfolio": string|null, "other": string[] },
          "currentTitle": string|null, "currentCompany": string|null, "totalYearsExperience": number|null,
          "summary": string|null,
          "experience": [{ "company": string|null, "title": string|null, "location": string|null,
                           "startDate": string|null, "endDate": string|null, "current": boolean,
                           "description": string|null }],
          "education": [{ "school": string|null, "degree": string|null, "fieldOfStudy": string|null,
                          "startDate": string|null, "endDate": string|null, "grade": string|null }],
          "skills": string[], "languages": string[], "certifications": string[]
        }
      `;

    // The model has no clock — without this, "Present" roles are counted up to its training cutoff.
    const today = new Date().toISOString().slice(0, 7);

    const userQuery = `
        TODAY'S DATE: ${today} (use for "Present" / current roles when computing totalYearsExperience)

        RESUME TEXT:
        """
        ${input.resumeText}
        """

        COMMAND: Return the JSON object described in the system instructions.
      `;

    return { systemInstruction, userQuery };
}

/** One field as the model sees it: compact, no ids for options (it answers with option labels). */
export type FillPromptField = {
    fieldId: string;
    type: string;
    question: string;
    hint?: string;
    /** The field's name/id when meaningful — often carries the block index of repeated sections */
    key?: string;
    required?: boolean;
    maxLength?: number;
    min?: string;
    max?: string;
    multiple?: boolean;
    options?: string[];
    moreOptions?: number;
    /** Eligibility / logistics question: answer only with a verbatim resume quote. */
    needsEvidence?: boolean;
};

export function buildAutofillFillRequest(
    fields: FillPromptField[],
    profile: AutofillProfile,
    resumeText: string,
    page: { url: string; title: string }
): { systemInstruction: string; userQuery: string } {
    const systemInstruction = `
        You fill in a job application form on behalf of a candidate, using ONLY the candidate's resume.
        You receive the form's fields and must return an answer for every field.

        HOW TO ANSWER EACH FIELD TYPE:
        - Text-like fields (text, email, tel, url, number, textarea, richtext, autocomplete, search):
          put the answer in "value" and set "options" to null.
        - date: "value" as YYYY-MM-DD. month: YYYY-MM. number/range: digits only, within min/max when given.
        - Fields with "options" (select, radio, checkbox-group, button-group, select-multiple):
          put the chosen option label(s) in "options", copied EXACTLY from the field's options list, and set
          "value" to null. Choose one option unless "multiple" is true or the type is checkbox-group.
          Long lists are pre-filtered to the options relevant to this candidate ("moreOptions" = how many were
          hidden). If the candidate's true answer is not among the options shown, give the resume's own value
          (e.g. the school name as written) — it is matched against the full list, and "Other" is chosen if absent.
        - checkbox (single box): "value" is "true" or "false".

        WHAT TO ANSWER:
        - Personal and contact details, links, location, work history, education, skills, languages and
          certifications: take them from the CANDIDATE PROFILE / RESUME. Copy emails, phone numbers and URLs
          exactly. Split names or dates as the field asks (e.g. "First name", "Graduation year").
        - Questions about the most recent / current job or degree use the most recent entry.
        - REPEATED BLOCKS: forms often repeat the same group of fields once per entry (several "Company" /
          "Job title" / "From" / "To" groups for work experience; several "School" / "Degree" groups for
          education; several "Language" fields). Fields arrive in page order: fill the 1st block with the most
          recent entry, the 2nd block with the next one, and so on — never repeat an entry, and leave blocks
          beyond the resume's entries null. A "key" containing an index (e.g. workExperience-2, educations[1])
          confirms which block a field belongs to. A "Currently work here" checkbox is "true" only for the
          current role's block; that block's end date is null.
        - Years-of-experience questions: use totalYearsExperience (or the experience relevant to the skill asked
          about) and pick the matching range option.
        - Open questions (cover letter, "Why do you want to work here?", "Tell us about yourself",
          "Describe a project"): write a genuine first-person answer grounded ONLY in facts from the resume,
          tailored to the role/company in the JOB PAGE when you can tell it. Professional tone, no placeholders,
          no invented employers, metrics or skills. Stay within maxLength characters (default: 120-200 words).
        - Yes/No questions about skills, experience, licences or achievements: "Yes" only when the resume shows
          it. Answer "No" ONLY when the resume settles it — e.g. "Have you worked at <Company>?" when the full work
          history does not include it. When the resume is merely silent (licences, management experience,
          open-source work, tools not mentioned), set value/options to null — silence is not a "No".
        - Country questions ("Which country…", "Country of residence"): the country alone ("United Kingdom"),
          not a city. City questions: the city alone. Use "City, Country" only when the field asks for a full
          location or address.
        - Time zone questions: derive from the candidate's location (e.g. Manchester, UK → GMT/UK time). If no option
          matches that time zone, answer null.
        - Fields marked "needsEvidence" (eligibility, legal status, agreements, salary, availability, follow-ups):
          answer ONLY when a sentence in the resume directly and unambiguously answers THIS exact question, and copy
          that sentence verbatim into "evidence". Otherwise value/options/evidence are all null. Specifically:
            * Never infer one country's work rights from another country's visa or from where the candidate lives.
            * Never infer willingness, intent, or the absence of agreements/restrictions — silence in the resume is
              not a "No".
            * The evidence must support the WHOLE chosen answer, not just part of it.
        - Anything the resume genuinely cannot answer (e.g. middle name when none is given): value and options null.
          Do not guess personal facts.

        OUTPUT: a single JSON object, no markdown or commentary:
        { "answers": [ { "fieldId": string, "value": string|null, "options": string[]|null, "evidence": string|null } ] }
        Include every fieldId from the input exactly once.
      `;

    const userQuery = `
        TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}

        JOB PAGE: ${JSON.stringify({ title: page.title, url: page.url })}

        CANDIDATE PROFILE (parsed from the resume):
        ${JSON.stringify(profile)}

        RESUME TEXT:
        """
        ${resumeText}
        """

        FORM FIELDS:
        ${JSON.stringify(fields)}

        COMMAND: Return the JSON object described in the system instructions.
      `;

    return { systemInstruction, userQuery };
}
