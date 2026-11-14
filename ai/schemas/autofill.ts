import { z } from 'zod';

/* ---------------------------------------------------------------------------
 * Autofill profile — structured facts extracted from the candidate's resume.
 * ------------------------------------------------------------------------- */

// Model output is untrusted: every field degrades to null / [] instead of
// failing the whole parse, so one malformed value doesn't lose the profile.
const optStr = (max = 500) => z.string().trim().max(max).nullable().catch(null);
const optNum = z.coerce.number().min(0).max(80).nullable().catch(null);
const strList = (maxItems = 100, maxLen = 200) =>
    z.array(z.string().trim().min(1).max(maxLen)).max(maxItems).catch([]);

const experienceItemSchema = z.object({
    company: optStr(200),
    title: optStr(200),
    location: optStr(200),
    /** "YYYY-MM" or "YYYY" when only the year is known. */
    startDate: optStr(20),
    endDate: optStr(20),
    current: z.boolean().catch(false),
    description: optStr(3000),
});

const educationItemSchema = z.object({
    school: optStr(200),
    degree: optStr(200),
    fieldOfStudy: optStr(200),
    startDate: optStr(20),
    endDate: optStr(20),
    grade: optStr(100),
});

export const autofillProfileSchema = z.object({
    firstName: optStr(100),
    lastName: optStr(100),
    fullName: optStr(200),
    email: optStr(254),
    phone: optStr(50),
    location: z
        .object({
            city: optStr(100),
            state: optStr(100),
            country: optStr(100),
            postcode: optStr(20),
        })
        .catch({ city: null, state: null, country: null, postcode: null }),
    links: z
        .object({
            linkedin: optStr(500),
            github: optStr(500),
            portfolio: optStr(500),
            other: strList(10, 500),
        })
        .catch({ linkedin: null, github: null, portfolio: null, other: [] }),
    currentTitle: optStr(200),
    currentCompany: optStr(200),
    totalYearsExperience: optNum,
    summary: optStr(3000),
    experience: z.array(experienceItemSchema).max(30).catch([]),
    education: z.array(educationItemSchema).max(15).catch([]),
    skills: strList(150),
    languages: strList(30),
    certifications: strList(50),
});

export type AutofillProfile = z.infer<typeof autofillProfileSchema>;

const resumeTextSchema = z.string().trim().min(50, 'Resume text is too short to parse').max(60_000);

export const autofillProfileInputSchema = z.object({
    resumeText: resumeTextSchema,
    /** Re-run the AI even if a cached (or user-edited) profile exists for this resume text. */
    forceRefresh: z.boolean().optional().default(false),
});

export type AutofillProfileInput = z.infer<typeof autofillProfileInputSchema>;

export const autofillProfileUpdateSchema = z.object({
    profileId: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid profileId'),
    profile: autofillProfileSchema,
});

/* ---------------------------------------------------------------------------
 * Form fill — the extension sends the fields its scraper found (same shape as
 * Extension/src/autofill/scraper.ts ScrapedField) and gets back a value for
 * each one. Unknown keys from the scraper are stripped by zod.
 * ------------------------------------------------------------------------- */

const nullableText = (max: number) =>
    z
        .string()
        .nullish()
        .transform((v) => (v ? v.slice(0, max) : null));

/**
 * Text copied from the page is trimmed, never rejected: sites put long values in attributes (SmartRecruiters'
 * email inputs carry long validation patterns), and one long attribute must not block autofill for the form.
 */
const clipped = (max: number) => z.string().transform((v) => v.slice(0, max));
const optionalClipped = (max: number) =>
    z
        .string()
        .nullish()
        .transform((v) => (v ? v.slice(0, max) : undefined));

const scrapedOptionSchema = z.object({
    optionId: z.string().max(120).optional(),
    value: clipped(500).optional().default(''),
    label: clipped(500).optional().default(''),
});

export const scrapedFieldSchema = z.object({
    fieldId: z.string().min(1).max(120),
    /** input type, or: textarea | select | select-multiple | radio | checkbox-group | button-group | autocomplete | richtext | file */
    type: clipped(40),
    label: nullableText(500),
    placeholder: nullableText(300),
    name: nullableText(200),
    /** Element id: meaningful on some ATSs (Greenhouse file inputs are id="resume" / id="cover_letter"). */
    id: nullableText(200),
    description: nullableText(1000),
    autocomplete: nullableText(100),
    required: z.boolean().optional().default(false).catch(false),
    maxLength: z.number().int().positive().optional().catch(undefined),
    /** HTML pattern attribute (e.g. "[0-9]{10}" tells a phone box wants a national number) */
    pattern: optionalClipped(300),
    min: optionalClipped(40),
    max: optionalClipped(40),
    multiple: z.boolean().optional().catch(undefined),
    readOnly: z.boolean().optional().catch(undefined),
    accept: optionalClipped(300),
    currentValue: nullableText(2000),
    /** Nearest heading above the field ("Referee 1"): a bare "Telephone no." there is the referee's number. */
    section: nullableText(300),
    options: z.array(scrapedOptionSchema).max(5000).optional().default([]),
});

export type ScrapedFieldInput = z.infer<typeof scrapedFieldSchema>;

export const autofillFillInputSchema = z.object({
    resumeText: resumeTextSchema,
    page: z
        .object({
            url: clipped(2000).optional().default(''),
            title: clipped(500).optional().default(''),
        })
        .optional()
        .default({ url: '', title: '' }),
    /**
     * A field the schema still can't read is dropped (and logged) rather than failing the whole request -
     * the rest of the form gets filled; the dropped one simply isn't touched.
     */
    fields: z
        .array(z.unknown())
        .min(1)
        .max(300)
        .transform((items, ctx) => {
            const ok: z.infer<typeof scrapedFieldSchema>[] = [];
            items.forEach((item, i) => {
                const parsed = scrapedFieldSchema.safeParse(item);
                if (parsed.success) ok.push(parsed.data);
                else console.warn('[autofill] Dropped unreadable field', i, JSON.stringify(parsed.error.issues.map((x) => x.path.join('.') + ': ' + x.message)));
            });
            if (!ok.length) ctx.addIssue({ code: 'custom', message: 'No readable fields' });
            return ok;
        }),
    /** "Add another" buttons of repeatable sections (work experience, education, ...). */
    addButtons: z
        .array(
            z.object({
                buttonId: z.string().min(1).max(120),
                label: clipped(200),
                section: nullableText(300),
            })
        )
        .max(50)
        .catch([])
        .optional()
        .default([]),
    /** The add buttons were already clicked for this form; don't ask to expand again. */
    expanded: z.boolean().optional().default(false),
    /**
     * The extension's id for this autofill run: its follow-up request (after clicking "Add another") isn't
     * counted as another autofill. Checked against a strict pattern where it's used.
     */
    runId: z.string().max(100).optional().catch(undefined),
});

export type AutofillFillInput = z.infer<typeof autofillFillInputSchema>;

/** Raw model output — validated loosely, then reconciled field by field in the handler. */
export const autofillFillOutputSchema = z.object({
    answers: z
        .array(
            z.object({
                fieldId: z.string(),
                value: z
                    .union([z.string(), z.number(), z.boolean()])
                    .nullish()
                    .transform((v) => (v === null || v === undefined ? null : String(v)))
                    .catch(null),
                options: z.array(z.string()).nullish().catch(null),
                evidence: z.string().nullish().catch(null),
            })
        )
        .catch([]),
});

export type AutofillFillOutput = z.infer<typeof autofillFillOutputSchema>;

/** Reply format the extension's plan.ts consumes (AutofillResponse). */
export interface AutofillFillResponse {
    profileId: string;
    /** The user's autofill allowance after this run (limit / remaining are null with Full Premium) */
    /** The user's autofill allowance after this run: free (lifetime) or Premium (today, UK time) */
    usage?: {
        used: number;
        limit: number;
        remaining: number;
        isPremium: boolean;
        period: 'lifetime' | 'day';
        resetsOn: string | null;
    };
    /** Resume has more entries than the form shows: click, rescan, ask again (answer lists are empty). */
    needsRescan?: boolean;
    expand?: { buttonId: string; times: number; section: string }[];
    /** Type `response` into the field */
    answers: { fieldId: string; response: string }[];
    /** Click each option */
    selections: { fieldId: string; optionIds: string[] }[];
    /**
     * Attach a file to this file input: the user's resume, or a cover letter the extension writes for this job
     * (with the existing cover-letter generator) and attaches.
     */
    uploads: { fieldId: string; file: 'resume' | 'cover_letter' }[];
    /** The candidate as read from the resume - sent when a cover letter is to be written (its sign-off and header) */
    candidate?: { name: string | null; email: string | null; phone: string | null };
    /** Left for the user; `skipped_reasons[fieldId]` says why */
    skipped: string[];
    skipped_reasons: Record<string, string>;
    stats: Record<string, number>;
}
