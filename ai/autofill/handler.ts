import { Request, Response } from 'express';
import type { AiOperation } from '../../billing/aiOperations';
import { normalizeAiProvider, recordAiCallForUser } from '../../billing/aiCallTracking';
import { computeResumeTextHash, getStoredAutofillProfile, saveAutofillProfile } from '../../autofill/store';
import { completeAutofillRun, hostOf, refundAutofillRun, reserveAutofillRun } from '../../billing/autofillEntitlements';
import type { GeminiRequestPayload } from '../geminiCore';
import { executeAiGeneration } from '../orchestrator';
import { buildAutofillFillRequest, buildAutofillProfileRequest, type FillPromptField } from '../prompts/autofill';
import {
    autofillFillInputSchema,
    autofillFillOutputSchema,
    autofillProfileInputSchema,
    autofillProfileSchema,
    autofillProfileUpdateSchema,
    type AutofillFillOutput,
    type AutofillFillResponse,
    type AutofillProfile,
    type ScrapedFieldInput,
} from '../schemas/autofill';
import type { OrchestratorSuccess } from '../types';
import { planExpansion } from './expansion';
import { isPhoneCodeField, isPhoneNumberField, phoneCountryName, phoneFor, phoneValueFor, pickDialCodeOptionId } from './phone';
import {
    PREFER_NOT_OPTION,
    HISTORY_FIELD,
    detectSensitiveField,
    evidenceMatchesTopic,
    resumeContainsEmail,
    resumeContainsEvidence,
    resumeContainsPhone,
    resumeContainsUrl,
    verifyProfileAgainstResume,
    type SensitiveMatch,
} from './fieldPolicy';

type AuthedRequest = Request & { user: { uid: string } };
type AiMeta = Pick<OrchestratorSuccess, 'provider' | 'model' | 'attempts' | 'latencyMs'>;

/** Fields per AI call. Batches run in parallel, so long forms don't take proportionally longer. */
const FILL_BATCH_SIZE = 25;
/** Options shown to the model per field; longer lists (countries, universities) are matched server-side. */
const MAX_PROMPT_OPTIONS = 150;

/** Yes / No (/ N/A) questions. */
const isYesNo = (field: ScrapedFieldInput) =>
    field.options.length >= 2 &&
    field.options.length <= 3 &&
    field.options.every((o) => /^(yes|no|y|n|n\/a|not\s+applicable)\b/i.test((o.label || o.value).trim()));

/** Yes/No questions the work history settles, so "No" is a fact: "Have you worked for Embraer before?" */
const HISTORY_QUESTION = /(worked|been\s+employed|employed)\s+(for|at|by|with)|previously\s+(worked|been\s+employed)|former\s+employee/i;

/** Plain country boxes ("Which country do you intend to work from?") take the country alone, not "City, Country". */
const COUNTRY_QUESTION = /\bcountry\b/i;
const NOT_RESIDENCE_COUNTRY = /code|phone|dial|calling|citizen|national|born|birth|passport|issu/i;

const OTHER_OPTION =/^\s*other\b|not\s+listed|none\s+of\s+the\s+(above|listed)/i;

const CHOICE_TYPES =new Set(['select', 'select-multiple', 'radio', 'checkbox-group', 'button-group']);
const MULTI_TYPES = new Set(['select-multiple', 'checkbox-group']);

/** Failure carrying the HTTP status to send, so helpers can bail out of the request cleanly. */
class AutofillError extends Error {
    constructor(
        readonly status: number,
        readonly body: Record<string, unknown>
    ) {
        super(String(body.message ?? body.error));
    }
}

function toGeminiPayload(systemInstruction: string, userQuery: string): GeminiRequestPayload {
    return {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ parts: [{ text: userQuery }] }],
    };
}

function extractResponseText(body: unknown): string {
    return (
        (body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates?.[0]?.content
            ?.parts?.[0]?.text ?? ''
    );
}

/** Tolerates code fences or stray prose around the object, even though JSON mode is requested. */
function parseJsonObject(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('No JSON object in AI response');
    return JSON.parse(text.slice(start, end + 1));
}

function logAutofillCall(userId: string, operation: AiOperation, route: string, aiMeta: AiMeta): void {
    const aiProvider = normalizeAiProvider(aiMeta.provider);
    if (!aiProvider) return;

    void recordAiCallForUser(userId, {
        category: 'extension_autofill',
        source: 'extension',
        route,
        operation,
        subcategory: operation === 'autofill_profile' ? 'profile' : 'fill',
        aiProvider,
        model: aiMeta.model,
        status: 'success',
        latencyMs: aiMeta.latencyMs,
        attempts: aiMeta.attempts,
        fallbackUsed: aiMeta.attempts > 1,
    }).catch((err) => console.warn('[ai-calls] log failed:', err));
}

function aiFailure(status: number, errorText: string): AutofillError {
    if (status === 500 && errorText === 'Server configuration error') {
        console.error('Missing AUTOFILL_GEMINI_API_KEY environment variable');
        return new AutofillError(500, { error: 'Server configuration error' });
    }

    console.error(`AI generation failed (${status}):`, errorText);

    // The provider's error text stays in the server log above - never sent to the browser
    if (status === 429) {
        return new AutofillError(429, { error: 'Too Many Requests' });
    }

    return new AutofillError(status >= 400 && status < 600 ? status : 502, { error: 'AI generation failed' });
}

function sendError(res: Response, error: unknown): void {
    if (error instanceof AutofillError) {
        res.status(error.status).json(error.body);
        return;
    }
    console.error('Internal Server Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
}

/* ---------------------------------------------------------------------------
 * Profile: resume text → structured facts, cached per resume text.
 * ------------------------------------------------------------------------- */

type ProfileResult = { profileId: string; profile: AutofillProfile; source: 'ai' | 'user'; cached: boolean };

async function getOrCreateProfile(
    userId: string,
    resumeText: string,
    route: string,
    forceRefresh = false
): Promise<ProfileResult> {
    const profileId = computeResumeTextHash(resumeText);

    if (!forceRefresh) {
        try {
            const stored = await getStoredAutofillProfile(userId, profileId);
            if (stored?.profile) {
                // Re-check AI profiles against today's rules (profiles parsed before the portfolio check);
                // the user's own corrections are kept as they are
                const profile = stored.source === 'ai' ? verifyProfileAgainstResume(stored.profile, resumeText) : stored.profile;
                return { profileId, profile, source: stored.source, cached: true };
            }
        } catch (error) {
            // Cache lookup failing shouldn't block a fresh AI call.
            console.error('[autofill] Failed to read cached profile:', error);
        }
    }

    const { systemInstruction, userQuery } = buildAutofillProfileRequest({ resumeText, forceRefresh });
    const result = await executeAiGeneration('autofill_profile', toGeminiPayload(systemInstruction, userQuery));
    if (!result.ok) throw aiFailure(result.status, result.errorText);

    let profile: AutofillProfile;
    try {
        const raw = parseJsonObject(extractResponseText(result.body));
        profile = verifyProfileAgainstResume(autofillProfileSchema.parse(raw), resumeText);
    } catch (parseErr) {
        console.error('[autofill] Failed to parse profile JSON:', parseErr, {
            finishReason: result.diagnostics?.finishReason,
        });
        throw new AutofillError(502, { error: 'AI_INVALID_FORMAT', message: 'Could not read the resume into a profile.' });
    }

    try {
        await saveAutofillProfile(userId, profileId, profile, 'ai', result.model);
    } catch (error) {
        // Persisting is best-effort — this request can still use the profile.
        console.error('[autofill] Failed to save profile:', error);
    }

    logAutofillCall(userId, 'autofill_profile', route, result);

    return { profileId, profile, source: 'ai', cached: false };
}

/**
 * POST /api/extension/autofill/profile
 * Resume text → structured autofill profile (for showing / correcting in the extension).
 */
export async function handleExtensionAutofillProfile(req: Request, res: Response): Promise<void> {
    const userId = (req as AuthedRequest).user.uid;
    const { input } = req.body as Record<string, unknown>;

    const parsed = autofillProfileInputSchema.safeParse(input);
    if (!parsed.success) {
        res.status(400).json({
            error: 'INVALID_INPUT',
            message: 'Invalid autofill profile input',
            details: parsed.error.flatten(),
        });
        return;
    }

    try {
        const result = await getOrCreateProfile(
            userId,
            parsed.data.resumeText,
            '/api/extension/autofill/profile',
            parsed.data.forceRefresh
        );
        res.status(200).json(result);
    } catch (error) {
        sendError(res, error);
    }
}

/**
 * PUT /api/extension/autofill/profile
 * Saves the user's corrections to a parsed profile; later fills use the corrected version. No AI call.
 */
export async function handleExtensionAutofillProfileUpdate(req: Request, res: Response): Promise<void> {
    const userId = (req as AuthedRequest).user.uid;
    const { input } = req.body as Record<string, unknown>;

    // Strict here (unlike model output): the user's own edits should be rejected, not silently nulled.
    const parsed = autofillProfileUpdateSchema.safeParse(input);
    if (!parsed.success) {
        res.status(400).json({
            error: 'INVALID_INPUT',
            message: 'Invalid autofill profile update',
            details: parsed.error.flatten(),
        });
        return;
    }

    const { profileId, profile } = parsed.data;

    try {
        const stored = await getStoredAutofillProfile(userId, profileId);
        if (!stored) {
            res.status(404).json({ error: 'PROFILE_NOT_FOUND', message: 'Parse this resume before editing its profile.' });
            return;
        }

        await saveAutofillProfile(userId, profileId, profile, 'user');
        res.status(200).json({ profileId, profile, source: 'user' });
    } catch (error) {
        console.error('[autofill] Failed to save profile update:', error);
        res.status(500).json({ error: 'SAVE_FAILED', message: 'Could not save your profile changes' });
    }
}

/* ---------------------------------------------------------------------------
 * Fill: scraped form fields → a value for every field the resume can answer.
 * ------------------------------------------------------------------------- */

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Option labels chosen by the model → the scraper's optionIds (exact, then value, then prefix/contains). */
function matchOptionIds(field: ScrapedFieldInput, labels: string[]): string[] {
    const ids: string[] = [];
    for (const label of labels) {
        const w = norm(label);
        if (!w) continue;
        const match =
            field.options.find((o) => norm(o.label) === w) ??
            field.options.find((o) => norm(o.value) === w) ??
            field.options.find((o) => norm(o.label).startsWith(w) || (norm(o.label).length > 1 && w.startsWith(norm(o.label)))) ??
            field.options.find((o) => norm(o.label).includes(w) || (norm(o.label).length > 2 && w.includes(norm(o.label))));
        if (match?.optionId && !ids.includes(match.optionId)) ids.push(match.optionId);
    }
    return ids;
}

function questionOf(field: ScrapedFieldInput): string {
    return field.label ?? field.placeholder ?? field.name ?? '';
}

const WEBSITE_QUESTION = /web\s*site|portfolio|home\s*page|personal\s+(site|url|page|link)/i;
const NOT_OWN_WEBSITE = /linkedin|github|twitter|facebook|instagram|social|company|employer|organi[sz]ation|project|how\s+did\s+you|where\s+did\s+you|hear/i;

/** A short "Website" / "Portfolio URL" box asking for the candidate's own site (not a long question about one). */
function isWebsiteField(field: ScrapedFieldInput): boolean {
    const q = questionOf(field);
    return (
        !field.options.length &&
        ['text', 'url'].includes(field.type) &&
        q.length <= 60 &&
        WEBSITE_QUESTION.test(q) &&
        !NOT_OWN_WEBSITE.test(q)
    );
}

const RESUME_FILE = /resume|r[ée]sum[ée]|\bcv\b|curriculum/i;
const OTHER_FILE = /cover\s*letter|transcript|portfolio|photo|picture|headshot|passport|\bid\b|certificate|sample|reference/i;
/**
 * The site's own "fill the form from your resume" import (SmartRecruiters "Choose an option to autocomplete
 * your application", Ashby "Autofill from resume"). Uploading there makes the site parse the CV and refill
 * the form itself, racing with ours - so it's only used when the form has no other place for the CV.
 */
const RESUME_IMPORT = /autocomplete\s+(your\s+)?application|autofill\s+(from|with)|apply\s+with\s+(your\s+)?(resume|cv)|import\s+(your\s+)?(resume|cv)|parse\s+(your\s+)?(resume|cv)|prefill/i;

/**
 * File inputs: 'resume' for CV fields, 'resume_import' for the site's own resume import, a skip reason for
 * other documents (cover letter, transcripts), 'generic' when nothing identifies it (Greenhouse labels every
 * upload button "Attach").
 */
function classifyFileField(field: ScrapedFieldInput): 'resume' | 'resume_import' | 'generic' | string {
    // ids/names use underscores ("cover_letter"), which \b treats as word characters
    const text = [field.label, field.description, field.name, field.id, field.placeholder]
        .filter(Boolean)
        .join(' ')
        .replace(/[_-]+/g, ' ');
    if (/cover\s*letter/i.test(text)) return 'cover_letter_file';
    if (RESUME_IMPORT.test(text)) return 'resume_import';
    if (RESUME_FILE.test(text)) return 'resume';
    if (OTHER_FILE.test(text)) return 'other_document';
    return 'generic';
}

/** Standard HTML autocomplete tokens → profile values: exact, no AI needed. */
function autocompleteValue(field: ScrapedFieldInput, profile: AutofillProfile): string | null {
    if (!field.autocomplete || field.options.length) return null;
    const token = field.autocomplete.trim().toLowerCase().split(/\s+/).pop();
    switch (token) {
        case 'given-name':
            return profile.firstName;
        case 'family-name':
            return profile.lastName;
        case 'name':
            return profile.fullName;
        case 'email':
            return profile.email;
        case 'tel':
        case 'tel-national':
            return profile.phone;
        case 'organization':
            return profile.currentCompany;
        case 'organization-title':
            return profile.currentTitle;
        case 'address-level2':
            return profile.location.city;
        case 'address-level1':
            return profile.location.state;
        case 'country-name':
            return profile.location.country;
        case 'postal-code':
            return profile.location.postcode;
        default:
            return null;
    }
}

const STOP_WORDS = new Set(['the', 'and', 'of', 'for', 'in', 'at', 'university', 'college', 'institute', 'school', 'technology', 'state', 'national']);

const tokensOf = (text: string) =>
    text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

/** "Vellore Institute of Technology" → "vit": lets a resume's short form find the list's long form. */
const acronymOf = (text: string) =>
    text
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => /^\p{Lu}/u.test(w) && !/^(of|and|the|for)$/i.test(w))
        .map((w) => w[0].toLowerCase())
        .join('');

/**
 * Long lists (3,000 universities, 250 countries) can't all go to the model. Show it the options that share
 * a word or acronym with the candidate's profile, plus any "Other / not listed" choice; the handler still
 * matches the answer against the full list.
 */
function promptOptions(labels: string[], profile: AutofillProfile): string[] {
    if (labels.length <= MAX_PROMPT_OPTIONS) return labels;

    const profileText = [
        ...profile.education.flatMap((e) => [e.school, e.degree, e.fieldOfStudy]),
        ...profile.experience.flatMap((e) => [e.company, e.title, e.location]),
        profile.location.city,
        profile.location.state,
        profile.location.country,
        ...profile.languages,
        ...profile.certifications,
    ]
        .filter(Boolean)
        .join(' ');
    const words = new Set(tokensOf(profileText));

    const relevant = labels.filter((label) => {
        if (OTHER_OPTION.test(label)) return true;
        const acronym = acronymOf(label);
        return (acronym.length >= 2 && words.has(acronym)) || tokensOf(label).some((t) => t.length >= 3 && words.has(t));
    });
    return relevant.slice(0, MAX_PROMPT_OPTIONS);
}

/**
 * name/id when it says something: repeated blocks often carry their index there
 * ("workExperience-2--companyName", "educations[1].school"). Generated ids ("question_69265206") are dropped.
 */
function fieldKey(field: ScrapedFieldInput): string | null {
    const key = field.name ?? field.id;
    if (!key || key.length > 80 || !/[a-z]{3,}/i.test(key) || /^(question|field|input)[_-]?\d+$/i.test(key)) return null;
    return key;
}

function toPromptField(field: ScrapedFieldInput, sensitive: SensitiveMatch | null, profile: AutofillProfile): FillPromptField {
    const allLabels = field.options.map((o) => o.label || o.value).filter(Boolean);
    const labels = promptOptions(allLabels, profile);
    const hint = [field.description, field.placeholder && field.placeholder !== field.label ? `placeholder: ${field.placeholder}` : null]
        .filter(Boolean)
        .join(' | ');
    return {
        fieldId: field.fieldId,
        type: field.type,
        question: questionOf(field) || field.name || '(no label)',
        ...(hint ? { hint } : {}),
        ...(fieldKey(field) ? { key: fieldKey(field)! } : {}),
        ...(field.required ? { required: true } : {}),
        ...(field.maxLength ? { maxLength: field.maxLength } : {}),
        ...(field.min ? { min: field.min } : {}),
        ...(field.max ? { max: field.max } : {}),
        ...(field.multiple || MULTI_TYPES.has(field.type) ? { multiple: true } : {}),
        ...(labels.length ? { options: labels } : {}),
        ...(allLabels.length > labels.length ? { moreOptions: allLabels.length - labels.length } : {}),
        ...(sensitive?.kind === 'evidence' ? { needsEvidence: true } : {}),
    };
}

function truncateAtWord(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const cut = text.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Validates a text answer against the field and the resume. Returns the value to type, or a skip reason.
 * Contact details must literally appear in the resume; numbers must respect min/max.
 */
function checkTextAnswer(field: ScrapedFieldInput, value: string, resumeText: string): { value: string } | { skip: string } {
    const q = questionOf(field);
    const type = field.type;

    if (type === 'email' || /e-?mail/i.test(q)) {
        if (!value.includes('@') || !resumeContainsEmail(resumeText, value)) return { skip: 'not_in_resume' };
    } else if (type === 'tel' || (/phone|mobile|\btel\b/i.test(q) && /\d{6,}/.test(value.replace(/\D/g, '')))) {
        if (!resumeContainsPhone(resumeText, value)) return { skip: 'not_in_resume' };
        // Never truncate a phone number (the word-boundary cut below left "+91" in 10-char boxes)
        if (field.maxLength && value.length > field.maxLength) {
            const digits = value.replace(/\D/g, '');
            return digits.length <= field.maxLength ? { value: digits } : { skip: 'phone_too_long' };
        }
        return { value };
    } else if (type === 'url' || /linkedin|github|portfolio|website|\burl\b/i.test(q)) {
        if (/^(https?:\/\/|www\.)|\.\w{2,}\//i.test(value) && !resumeContainsUrl(resumeText, value)) return { skip: 'not_in_resume' };
    }

    // Browsers silently reject a date in the wrong shape, leaving the box empty
    if (type === 'date' || type === 'month') {
        const m = value.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
        if (!m) return { skip: 'no_resume_data' };
        return { value: type === 'month' ? `${m[1]}-${m[2]}` : `${m[1]}-${m[2]}-${m[3] ?? '01'}` };
    }

    if (type === 'number' || type === 'range') {
        const n = Number(value.replace(/[^\d.-]/g, ''));
        if (!Number.isFinite(n)) return { skip: 'no_resume_data' };
        const min = field.min !== undefined ? Number(field.min) : -Infinity;
        const max = field.max !== undefined ? Number(field.max) : Infinity;
        return { value: String(Math.min(Math.max(n, Number.isFinite(min) ? min : -Infinity), Number.isFinite(max) ? max : Infinity)) };
    }

    return { value: field.maxLength ? truncateAtWord(value, field.maxLength) : value };
}

async function runFillBatch(
    userId: string,
    batch: FillPromptField[],
    profile: AutofillProfile,
    resumeText: string,
    page: { url: string; title: string }
): Promise<AutofillFillOutput['answers']> {
    const { systemInstruction, userQuery } = buildAutofillFillRequest(batch, profile, resumeText, page);
    const result = await executeAiGeneration('autofill_fill', toGeminiPayload(systemInstruction, userQuery));
    if (!result.ok) throw aiFailure(result.status, result.errorText);

    logAutofillCall(userId, 'autofill_fill', '/api/extension/autofill/fill', result);

    try {
        return autofillFillOutputSchema.parse(parseJsonObject(extractResponseText(result.body))).answers;
    } catch (parseErr) {
        console.error('[autofill] Failed to parse fill JSON:', parseErr, { finishReason: result.diagnostics?.finishReason });
        throw new AutofillError(502, { error: 'AI_INVALID_FORMAT', message: 'Could not read the AI answers.' });
    }
}

/**
 * POST /api/extension/autofill/fill
 * Resume text + the fields the extension scraped from an application form → what to type, pick or attach
 * for each field. Every field lands in exactly one of answers / selections / uploads / skipped.
 */
export async function handleExtensionAutofillFill(req: Request, res: Response): Promise<void> {
    const userId = (req as AuthedRequest).user.uid;
    const { input } = req.body as Record<string, unknown>;

    const parsed = autofillFillInputSchema.safeParse(input);
    if (!parsed.success) {
        res.status(400).json({
            error: 'INVALID_INPUT',
            message: 'Invalid autofill fill input',
            details: parsed.error.flatten(),
        });
        return;
    }

    const { resumeText, page, fields } = parsed.data;

    const seen = new Set<string>();
    for (const field of fields) {
        if (seen.has(field.fieldId)) {
            res.status(400).json({ error: 'INVALID_INPUT', message: `Duplicate fieldId: ${field.fieldId}` });
            return;
        }
        seen.add(field.fieldId);
    }

    // The run this request belongs to - refunded below if the answers can't be generated
    let runDocId: string | null = null;
    try {
        // Free plan: 5 autofills for the account's lifetime; Full Premium: 20 per day. Checked
        // and counted on the server before any AI work; a run's follow-up request isn't counted again.
        const reserve = await reserveAutofillRun(userId, parsed.data.runId, {
            host: hostOf(page.url),
            fieldCount: fields.length,
        });
        if (!reserve.ok) {
            res.status(402).json({
                error: reserve.reason,
                message: reserve.message,
                isPremium: reserve.isPremium,
                used: reserve.used,
                limit: reserve.limit,
                remaining: reserve.remaining,
                period: reserve.period,
                resetsOn: reserve.resetsOn,
            });
            return;
        }
        runDocId = reserve.runDocId;
        const usage = {
            used: reserve.used,
            limit: reserve.limit,
            remaining: reserve.remaining,
            isPremium: reserve.isPremium,
            period: reserve.period,
            resetsOn: reserve.resetsOn,
        };

        const { profileId, profile } = await getOrCreateProfile(userId, resumeText, '/api/extension/autofill/fill');

        // 0. More resume entries than blocks on the form: have the extension click "Add another" first.
        //    Answered before any AI call — the fields are about to change.
        if (!parsed.data.expanded && parsed.data.addButtons.length) {
            const expand = planExpansion(parsed.data, profile);
            if (expand.length) {
                const early: AutofillFillResponse = {
                    profileId,
                    usage,
                    needsRescan: true,
                    expand,
                    answers: [],
                    selections: [],
                    uploads: [],
                    skipped: [],
                    skipped_reasons: {},
                    stats: { total: fields.length, expandClicks: expand.reduce((n, e) => n + e.times, 0) },
                };
                res.status(200).json(early);
                return;
            }
        }

        const response: AutofillFillResponse = {
            profileId,
            usage,
            answers: [],
            selections: [],
            uploads: [],
            skipped: [],
            skipped_reasons: {},
            stats: {},
        };
        const skip = (fieldId: string, reason: string) => {
            response.skipped.push(fieldId);
            response.skipped_reasons[fieldId] = reason;
        };

        // 1. Rules first: files, never-fill questions, demographics, exact autocomplete matches.
        const forAi: Array<{ field: ScrapedFieldInput; sensitive: SensitiveMatch | null }> = [];
        // Two or more company / school fields = a history form (a lone "Current company" is not)
        const formHasHistory =
            fields.filter((f) => HISTORY_FIELD.test([f.label, f.placeholder, f.name, f.id].filter(Boolean).join(' '))).length >= 2;
        const phone = phoneFor(profile);
        const formHasCodeField = fields.some(isPhoneCodeField);
        const fileKinds = new Map(fields.filter((f) => f.type === 'file').map((f) => [f.fieldId, classifyFileField(f)]));
        // An unidentified upload is the CV only when the page has no field that clearly is; then just the first one.
        // Where the CV goes: fields that clearly ask for it; else the first unlabelled upload; else, as a last
        // resort, the site's own resume import
        const kinds = [...fileKinds.values()];
        const fallbackResumeId = kinds.includes('resume')
            ? null
            : ([...fileKinds.entries()].find(([, kind]) => kind === 'generic')?.[0] ??
              [...fileKinds.entries()].find(([, kind]) => kind === 'resume_import')?.[0] ??
              null);

        for (const field of fields) {
            if (field.type === 'file') {
                const kind = fileKinds.get(field.fieldId)!;
                if (kind === 'resume' || field.fieldId === fallbackResumeId) {
                    response.uploads.push({ fieldId: field.fieldId, file: 'resume' });
                } else if (kind === 'cover_letter_file' && !response.uploads.some((u) => u.file === 'cover_letter')) {
                    // The extension writes a cover letter for this job and attaches it (one per form)
                    response.uploads.push({ fieldId: field.fieldId, file: 'cover_letter' });
                    response.candidate = { name: profile.fullName, email: profile.email, phone: profile.phone };
                } else {
                    skip(field.fieldId, kind === 'generic' ? 'other_document' : kind);
                }
                continue;
            }

            // Existing values are NOT skipped: forms pre-populate defaults ("0" years, "3" lacs) and earlier
            // runs leave stale text, and the user asked for the form to be filled from this resume.

            // Never-fill questions first: "Emergency contact phone" / "Reference email" must not get the
            // candidate's own details through the phone rules or the AI below.
            const sensitive = detectSensitiveField(field, formHasHistory);
            if (sensitive?.kind === 'never') {
                skip(field.fieldId, sensitive.reason);
                continue;
            }

            // Phone number + dial code: by rule (exact code match, national/international split).
            if (isPhoneCodeField(field)) {
                if (!phone) {
                    skip(field.fieldId, 'no_resume_data');
                } else if (field.options.length) {
                    const optionId = pickDialCodeOptionId(field, phone);
                    if (optionId) response.selections.push({ fieldId: field.fieldId, optionIds: [optionId] });
                    else skip(field.fieldId, 'no_matching_option');
                } else {
                    // Searchable picker (SmartRecruiters' country-code autocomplete): type the country, since
                    // "+44" would match Guernsey / Jersey / UK alike. A plain code box gets "+44".
                    response.answers.push({
                        fieldId: field.fieldId,
                        response: field.type === 'autocomplete' ? phoneCountryName(phone, profile) : `+${phone.code}`,
                    });
                }
                continue;
            }
            if (isPhoneNumberField(field)) {
                const value = phone ? phoneValueFor(field, phone, formHasCodeField) : profile.phone;
                if (!value) skip(field.fieldId, 'no_resume_data');
                // Never cut a phone number short: a partial number is worse than an empty box
                else if (field.maxLength && value.length > field.maxLength) skip(field.fieldId, 'phone_too_long');
                else response.answers.push({ fieldId: field.fieldId, response: value });
                continue;
            }

            // "Website" / "Portfolio": only the candidate's own site. The AI would offer a project link instead.
            if (isWebsiteField(field)) {
                if (profile.links.portfolio) response.answers.push({ fieldId: field.fieldId, response: profile.links.portfolio });
                else skip(field.fieldId, 'no_resume_data');
                continue;
            }

            if (sensitive?.kind === 'eeo') {
                const preferNot = field.options.find((o) => PREFER_NOT_OPTION.test(o.label || o.value));
                if (preferNot?.optionId) response.selections.push({ fieldId: field.fieldId, optionIds: [preferNot.optionId] });
                else skip(field.fieldId, sensitive.reason);
                continue;
            }

            if (
                !sensitive &&
                !field.options.length &&
                ['text', 'autocomplete', 'search'].includes(field.type) &&
                COUNTRY_QUESTION.test(questionOf(field)) &&
                !NOT_RESIDENCE_COUNTRY.test(questionOf(field)) &&
                profile.location.country
            ) {
                response.answers.push({ fieldId: field.fieldId, response: profile.location.country });
                continue;
            }

            const direct = sensitive ? null : autocompleteValue(field, profile);
            if (direct) {
                response.answers.push({ fieldId: field.fieldId, response: direct });
                continue;
            }

            forAi.push({ field, sensitive });
        }

        // 2. AI answers everything else, in parallel batches.
        const answersById = new Map<string, AutofillFillOutput['answers'][number]>();
        const failedIds = new Set<string>();
        let firstFailure: unknown = null;

        const batches: Array<typeof forAi> = [];
        for (let i = 0; i < forAi.length; i += FILL_BATCH_SIZE) batches.push(forAi.slice(i, i + FILL_BATCH_SIZE));

        const outcomes = await Promise.allSettled(
            batches.map((batch) =>
                runFillBatch(
                    userId,
                    batch.map(({ field, sensitive }) => toPromptField(field, sensitive, profile)),
                    profile,
                    resumeText,
                    page
                )
            )
        );
        outcomes.forEach((outcome, i) => {
            if (outcome.status === 'fulfilled') {
                for (const answer of outcome.value) answersById.set(answer.fieldId, answer);
            } else {
                firstFailure ??= outcome.reason;
                batches[i].forEach(({ field }) => failedIds.add(field.fieldId));
            }
        });

        // Nothing came back at all: report the AI failure rather than an empty fill.
        if (forAi.length > 0 && failedIds.size === forAi.length && response.answers.length + response.selections.length === 0) {
            throw firstFailure;
        }

        // 3. Reconcile each AI answer with the field and the resume.
        for (const { field, sensitive } of forAi) {
            if (failedIds.has(field.fieldId)) {
                skip(field.fieldId, 'ai_unavailable');
                continue;
            }
            const answer = answersById.get(field.fieldId);
            if (!answer) {
                skip(field.fieldId, 'no_resume_data');
                continue;
            }

            if (
                sensitive?.kind === 'evidence' &&
                !(resumeContainsEvidence(resumeText, answer.evidence ?? null) && evidenceMatchesTopic(sensitive.reason, answer.evidence ?? null))
            ) {
                skip(field.fieldId, sensitive.reason);
                continue;
            }

            const isChoice = CHOICE_TYPES.has(field.type) || (field.options.length > 0 && field.type !== 'autocomplete');
            if (isChoice) {
                const labels = answer.options?.length ? answer.options : answer.value ? [answer.value] : [];
                let optionIds = matchOptionIds(field, labels);
                // The resume has an answer the list doesn't ("VIT University" vs a US-school list): pick
                // "Other (School Not Listed)" when the form offers it, as such questions usually instruct.
                if (!optionIds.length && labels.length && !(field.multiple || MULTI_TYPES.has(field.type))) {
                    const other = field.options.find((o) => OTHER_OPTION.test(o.label || o.value));
                    if (other?.optionId) optionIds = [other.optionId];
                }
                if (!(field.multiple || MULTI_TYPES.has(field.type))) optionIds = optionIds.slice(0, 1);
                // A "No" on a Yes/No question asserts something the resume rarely settles (licences,
                // tools, management): keep it only when the work history answers it ("Worked for X before?")
                const chosen = field.options.find((o) => o.optionId === optionIds[0]);
                if (isYesNo(field) && chosen && /^no\b/i.test(norm(chosen.label || chosen.value)) && !HISTORY_QUESTION.test(questionOf(field))) {
                    skip(field.fieldId, 'no_resume_data');
                    continue;
                }
                if (optionIds.length) response.selections.push({ fieldId: field.fieldId, optionIds });
                else skip(field.fieldId, labels.length ? 'no_matching_option' : 'no_resume_data');
                continue;
            }

            if (field.type === 'checkbox') {
                const v = norm(answer.value);
                if (v === 'true' || v === 'yes') response.answers.push({ fieldId: field.fieldId, response: 'true' });
                else if (v === 'false' || v === 'no') response.answers.push({ fieldId: field.fieldId, response: 'false' });
                else skip(field.fieldId, 'no_resume_data');
                continue;
            }

            const raw = (answer.value ?? answer.options?.[0] ?? '').trim();
            if (!raw) {
                skip(field.fieldId, 'no_resume_data');
                continue;
            }
            const checked = checkTextAnswer(field, raw, resumeText);
            if ('skip' in checked) skip(field.fieldId, checked.skip);
            else response.answers.push({ fieldId: field.fieldId, response: checked.value });
        }

        response.stats = {
            total: fields.length,
            answered: response.answers.length,
            selected: response.selections.length,
            uploaded: response.uploads.length,
            skipped: response.skipped.length,
            aiBatches: batches.length,
        };

        void completeAutofillRun(userId, runDocId, {
            answered: response.answers.length,
            selected: response.selections.length,
            uploaded: response.uploads.length,
            skipped: response.skipped.length,
        });
        res.status(200).json(response);
    } catch (error) {
        // No answers came back: this autofill doesn't count
        if (runDocId) await refundAutofillRun(userId, runDocId);
        sendError(res, error);
    }
}
