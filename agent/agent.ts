import { z } from 'zod';
import { executeAiGeneration } from '../ai/orchestrator';
import {
    MAX_SUGGESTIONS,
    suggestionSchema,
    uiPieceSchema,
    type AgentBlock,
    type AgentHistoryTurn,
    type UiPiece,
} from './contract';
import type { JobListCard } from './contract';
import { nextJobLists } from './jobs/lists';
import { cvContextSummary, type CvIndex } from './cv';
import { CvTextMatcher } from './cv/profile';
import { firstJsonObject } from './json';
import { coercePiece } from './pieces';
import { withoutDateStatus } from './knowledge/govuk';
import { asksAboutSoc, forcedToolCalls } from './routing';
import { buildStepMessage, buildSystemPrompt } from './prompt';
import type { AgentEventSink } from './sse';
import { textDeltas } from './sse';
import { AGENT_TOOLS, findTool, type AgentTool } from './tools';
import { CV_TOOLS, cvProfileCard } from './tools/cv';
import { CV_TEMPLATE_CATALOGUE, CV_TEMPLATE_TOOL } from './tools/cvTemplate';
import { isAboutOwnCv, isCvSummaryRequest } from './cvIntent';
import { asksInterviewQuestion, interviewNote, interviewState } from './interview';
import { splitPastedAdvert } from './jobs/jobDescription';
import { withinMs } from './cache';

const CV_TOOL_NAMES = new Set(CV_TOOLS.map((tool) => tool.name));
/** The answer asks the user to pick a CV, so the picker is shown with it. */
const ASKS_FOR_CV = /\b(?:choose|select|pick|share|add)\b[^.?!]{0,40}\bCVs?\b/i;
import type { AgentAiCall } from './usage';

export { firstJsonObject };

export const MAX_AGENT_STEPS = 5;
const MAX_TOOL_CALLS_PER_STEP = 3;
const MAX_TOOL_CALLS_PER_TURN = 6;
/** With less time than this left before the turn deadline, the model must answer now. */
const ANSWER_RESERVE_MS = 12_000;
const DEADLINE_MARGIN_MS = 1500;
const SEARCH_SLOW_TEXT = 'That search took too long this time. Please try again in a moment.';
const MAX_TOOL_RESULT_CHARS = 6000;
/** A tool still running this close to the turn deadline is given up on, so there is time left to answer. */
const TOOL_RESERVE_MS = 8_000;
const SLOW_SEARCH_RESULT = { error: 'SEARCH_SLOW', instruction: 'Say the search took too long this time and to try again in a moment. Do not guess why. Never say a tool is unavailable and never list jobs from memory.' };
const MAX_PARSE_ATTEMPTS = 3;

const MAX_ANSWER_CHARS = 8000;

/** Cuts over-long text at the last sentence end, so a long answer is shortened, never rejected. */
export function cutAtSentence(text: string, max = MAX_ANSWER_CHARS): string {
    if (text.length <= max) return text;
    const slice = text.slice(0, max);
    const end = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('\n'));
    return (end > max * 0.6 ? slice.slice(0, end + 1) : slice).trimEnd();
}

/** Extra items are sliced off instead of failing the whole step: one surplus item never costs an answer. */
const modelStepSchema = z.object({
    toolCalls: z
        .array(z.object({ name: z.string().max(64), args: z.record(z.string(), z.unknown()).default({}) }))
        .transform((calls) => calls.slice(0, MAX_TOOL_CALLS_PER_STEP))
        .optional(),
    answer: z
        .object({
            text: z.string().trim().min(1).transform((t) => cutAtSentence(t)),
            ui: z.array(z.unknown()).default([]).transform((ui) => ui.slice(0, 12)),
            /** Clickable answers to the question "text" asks, if it asks one; becomes a choices piece. */
            choices: z.unknown().optional(),
            suggestions: z.array(z.unknown()).default([]).transform((s) => s.slice(0, 8)),
        })
        .optional(),
});

export interface AgentAnswer {
    text: string;
    pieces: UiPiece[];
    suggestions: string[];
}

export interface AgentRunDeps {
    generate?: typeof executeAiGeneration;
    tools?: AgentTool[];
}

export interface AgentRunResult {
    answer: AgentAnswer | null;
    steps: number;
    calls: AgentAiCall[];
    /** Every block shown this turn, in order, so the conversation can be re-opened without AI. */
    blocks: AgentBlock[];
    /** Names of the tools that ran (for daily usage totals). */
    toolsUsed: string[];
    /** Why no answer was produced (a code for logs and totals, never text). */
    failure?: 'ai_error' | 'unreadable' | 'no_answer' | 'cancelled';
}

export interface AgentRunInput {
    uid: string;
    message: string;
    history: AgentHistoryTurn[];
    summary?: string;
    cv?: CvIndex | null;
    /** Blocks the handler already sent this turn (e.g. the CV card); tools will not repeat them. */
    preEmitted?: Array<{ id: string; block: AgentBlock }>;
    /** Epoch ms by which the turn must finish; near it the model answers with what it has. */
    deadlineAt?: number;
    /** Set by the safety gate: the user asks about their own legal or visa situation. */
    caution?: 'personal_legal';
    /** Recent job lists in this conversation, newest first, for follow-ups. */
    jobLists?: JobListCard[];
    /** A tailored CV ("/cv") on the user's screen, so its template can be changed from the chat. */
    tailoredCv?: { template: string };
}

/**
 * Keeps every valid piece; one bad piece never costs the user the whole answer.
 * CV quotes survive only if the words really are in the user's CV.
 */
export function cleanAnswer(
    raw: { text: string; ui: unknown[]; choices?: unknown; suggestions: unknown[] },
    quoteIsInCv: (text: string) => boolean = () => false,
): AgentAnswer {
    // The answer's own "choices" field (a question back to the user) joins the pieces as a choices piece.
    const choiceField = raw.choices && typeof raw.choices === 'object' ? (Array.isArray(raw.choices) ? { type: 'choices', options: raw.choices } : { type: 'choices', ...raw.choices }) : null;
    const pieces = [...raw.ui, ...(choiceField ? [choiceField] : [])].flatMap((piece) => {
        const parsed = uiPieceSchema.safeParse(coercePiece(piece));
        if (!parsed.success) return [];
        if (parsed.data.type === 'quote' && !quoteIsInCv(parsed.data.text)) return [];
        if ((parsed.data.type === 'paragraph' || parsed.data.type === 'heading') && repeats(parsed.data.text, raw.text)) return [];
        return [parsed.data];
    });
    // One set of choices, after everything it asks about; follow-ups that only repeat an option are dropped.
    const choices = pieces.find((piece) => piece.type === 'choices');
    if (choices) pieces.splice(0, pieces.length, ...pieces.filter((piece) => piece.type !== 'choices'), choices);
    const seen = new Set<string>(choices?.type === 'choices' ? choices.options.map((o) => o.toLowerCase()) : []);
    const suggestions = raw.suggestions.flatMap((item) => {
        const parsed = suggestionSchema.safeParse(item);
        if (!parsed.success) return [];
        const key = parsed.data.toLowerCase();
        if (seen.has(key)) return [];
        seen.add(key);
        return [parsed.data];
    });
    return { text: raw.text, pieces, suggestions: suggestions.slice(0, MAX_SUGGESTIONS) };
}

/** Pieces that only repeat SOC codes or figures already shown in a tool's own card are dropped. */
export function withoutCardRepeats(pieces: UiPiece[], shown: AgentBlock[]): UiPiece[] {
    const codes = new Set<string>();
    const figures = new Set<string>();
    const jobTitles = new Set<string>();
    for (const block of shown) {
        if (block.kind === 'socCards') block.card.options.forEach((o) => codes.add(o.code));
        if (block.kind === 'officialFacts') block.card.facts.forEach((f) => figures.add(f.value));
        if (block.kind === 'jobList') block.card.items.forEach((job) => jobTitles.add(job.title.toLowerCase()));
    }
    // A list of the jobs already on the cards says the same thing twice.
    if (jobTitles.size) pieces = pieces.filter((piece) => !(piece.type === 'list' && piece.items.some((item) => [...jobTitles].some((title) => item.title.toLowerCase().includes(title)))));
    if (!codes.size && !figures.size) return pieces;
    const repeatsCard = (text: string) =>
        [...codes].some((code) => new RegExp(`\\b${code}\\b`).test(text)) || [...figures].some((value) => value.length > 2 && text.includes(value));
    return pieces.filter((piece) => {
        if (piece.type === 'list') return !piece.items.some((item) => repeatsCard(`${item.title} ${item.text ?? ''}`));
        if (piece.type === 'facts') return !piece.items.some((item) => repeatsCard(`${item.label} ${item.value}`));
        return true;
    });
}

const SOC_CODE_MENTION = /\bSOC(?:\s+2020)?(?:\s+code)?s?\s*:?\s*(\d{4})\b/gi;
const POUND_AMOUNT = /£\s?(\d[\d,]*(?:\.\d+)?)/g;
const GOING_RATE_SUM = /\d+\s*%\s+of\s+(?:the\s+|that\s+|its\s+)?going[- ]rate/i;
const VISA_PAY_TOPIC = /\bvisas?\b|minimum wage|living wage|\b(?:an|per) hour\b|skilled worker|sponsor|going rate|threshold|salary (?:requirement|floor|rule)|minimum salary|new entrant|\bSOC\b/i;

/** True when a SOC code, or a pound figure in a visa pay sentence, is not in the official data or the user's own words. */
function hasUnverifiedFigure(text: string, evidence: string): boolean {
    for (const m of text.matchAll(SOC_CODE_MENTION)) if (!evidence.includes(m[1]!)) return true;
    if (!VISA_PAY_TOPIC.test(text)) return false;
    // "£8.00" is the same figure as an official "£8".
    for (const m of text.matchAll(POUND_AMOUNT)) if (!evidence.includes(m[1]!.replace(/,/g, '').replace(/\.0+$/, ''))) return true;
    return false;
}

const FIGURE_REMOVED = 'I can only give SOC codes and visa salary figures from the official data, and I could not confirm that figure here. Tell me the job title or SOC code and I will look it up.';

/**
 * SOC codes and visa pay figures must come from official data, never model memory. The prompt says so;
 * this enforces it: a sentence or card piece with a figure not found in this turn's tool results is removed.
 */
export function withoutUnverifiedFigures<T extends { text: string; pieces: UiPiece[] }>(answer: T, evidenceText: string, officialCardShown = false): T {
    const evidence = evidenceText.replace(/(\d),(?=\d)/g, '$1');
    // With an official card on screen the AI restates nothing: a real figure with a wrong explanation misleads too.
    const restates = (text: string) => officialCardShown && ((POUND_AMOUNT.test(text) && VISA_PAY_TOPIC.test(text)) || GOING_RATE_SUM.test(text));
    const bad = (text: string) => {
        POUND_AMOUNT.lastIndex = 0;
        const restated = restates(text);
        POUND_AMOUNT.lastIndex = 0;
        return restated || hasUnverifiedFigure(text, evidence);
    };
    const sentences = answer.text.split(/(?<=[.!?])\s+/);
    // A sentence that leans on a removed one ("This applies...", "During this period...") means nothing alone, so it goes too.
    let previousRemoved = false;
    const remaining = sentences.filter((s) => {
        previousRemoved = bad(s) || (previousRemoved && /^(?:this|that|these|those|it|they|during|such|once|then|after that)\b/i.test(s));
        return !previousRemoved;
    });
    // A sentence that followed a removed one must not open with "However".
    const kept = remaining.map((s, i) => (i === 0 ? s.replace(/^(?:however|but|also),?\s+(\w)/i, (_, c: string) => c.toUpperCase()) : s));
    const removedNote = officialCardShown ? 'The exact figures are in the official card below.' : evidenceText.includes('gov_uk_guidance') ? 'I left out a figure I could not confirm. The GOV.UK pages linked here have the exact figures.' : FIGURE_REMOVED;
    return {
        ...answer,
        text: sentences.every((s) => !bad(s)) ? answer.text : [...kept, removedNote].join(' '),
        pieces: answer.pieces.filter((piece) => !bad(JSON.stringify(piece))),
    };
}

const OVERCLAIM = /\b(?:perfect|ideal|excellent|great|strong|good)\s+(?:match|fit)\b|\bperfect\b/i;

/** The verdict is decided by code. If no job in this turn is a close match, the AI cannot call one a strong match. */
export function withoutOverclaim(text: string, toolResultsJson: string): string {
    if (!/"label":"(?:stretch|possible)"/.test(toolResultsJson) || /"label":"close"/.test(toolResultsJson)) return text;
    const sentences = text.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => !OVERCLAIM.test(s));
    return kept.length ? kept.join(' ') : text;
}

/** "Will Google sponsor me?" is not answered by a licence: the fact stays, the "Yes" goes. */
export function withoutLicenceYes(text: string, message: string): string {
    if (!/\bsponsor\s+me\b/i.test(message)) return text;
    const rest = text.replace(/^\s*yes\b[,.!:]?\s*/i, '');
    return rest === text || !rest ? text : rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Nobody can promise this, however close the job: no job or result is certain. */
export function withoutPromise(text: string): string {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => !/\bapply\s+(?:with\s+)?confiden|\bconfidently\s+(?:apply|consider|go for)|\bguarantee[sd]?\s+(?:to|you|a)\b|\bwill\s+(?:definitely|certainly)\b/i.test(s) || /\b(?:cannot|can't|no|not)\b/i.test(s));
    return kept.length ? kept.join(' ') : text;
}

/** The start of the answer matches the last answer word for word. */
export function repeatsLastAnswer(text: string, history: AgentHistoryTurn[]): boolean {
    const last = [...history].reverse().find((turn) => turn.role === 'assistant')?.text;
    if (!last) return false;
    const opening = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 12).join(' ');
    return opening(text).split(' ').length >= 8 && opening(text) === opening(last);
}

/** A visa answer must rest on official data; a job answer carries its own official visa facts. */
const MENTIONS_VISA_RULES = /\b(?:skilled worker|visa (?:route|rules?|requirements?)|sponsor licen[cs]e|sponsorship|immigration salary list|temporary shortage list|going rate|RQF ?\d?)\b/i;
const SMALL_TALK = /^(?:hi|hello|hey|thanks|thank you|who are you|what can you do|how can you help|what do you do|good (?:morning|afternoon|evening))\b(?:[^?]{0,30}(?:what can you do|who are you|how can you help))?[\s?!.]*$/i;
const NAMES_A_JOB = /\b(?:as|be|become)\s+an?\s+[a-z]/i;
const OFFICIAL_OR_JOB_TOOLS = new Set(['gov_uk_guidance', 'soc_lookup', 'visa_salary_rules', 'find_sponsors', 'search_jobs', 'recommend_jobs', 'job_details', 'job_fit']);
const CLAIMS_NO_JOBS = /\b(?:can(?:no|'?)t|could(?:n'?t| not)|unable to|not able to|wasn'?t able to) find\b[^.!?]{0,40}\bjobs?\b|\bno\b[^.!?]{0,20}\bjobs?\b[^.!?]{0,20}\b(?:found|available|match)/i;

/** They asked for something written, so the words themselves must be in the answer. */
export function asksToWrite(message: string): boolean {
    // "How do I write a cover letter?" wants advice, not a letter.
    if (/\b(?:how|what|when|why|should|tips?|advice)\b/i.test(message)) return false;
    return /\b(?:write|draft|compose|redraft|rewrite)\b[^.?!]{0,40}\b(?:cover letter|letter|e-?mail|personal statement|statement|message|bio|introduction)\b/i.test(message);
}

export { startsMockInterview } from './interview';

/** Said when the model gave no readable reply but real cards are on screen. Names the list, so "job 1" later has context. */
export function cardsOnlyText(blocks: AgentBlock[]): string {
    const list = [...blocks].reverse().find((b) => b.kind === 'jobList' && !b.card.hidden && !b.card.pick);
    return list?.kind === 'jobList'
        ? `Here are ${list.card.items.length} jobs: ${list.card.query}. Ask me about any of them by number.`
        : 'Here is what I found. Ask me if you would like any of it explained.';
}

const HOPELESS = /\bfeel(?:ing)?\s+(?:like\s+)?(?:giving|give)\s+up\b|\bgiving up on (?:everything|life)\b|\bcan(?:no|'|\u2019)?t\s+go\s+on(?:\s+like\s+this|\s+any\s*more)?(?!\s*\w)|\bhopeless\b|\bno point (?:in )?(?:living|going on|anymore|any more)\b|\bkill(?:ing)? myself\b|\bsuicid|\bself[- ]?harm|\bhurt(?:ing)? myself\b|\bend (?:it all|my life)\b|\bwant to die\b|\bdon'?t want to (?:be here|live)\b/i;

/** The remote filter finds adverts that mention remote or home working, which can include hybrid jobs, and the reader must know. */
export function withRemoteNote(text: string, results: Array<{ name: string; result?: unknown }>): string {
    // A long result reaches here as a text preview, so read the flag from its text.
    const searched = results.some((r) => r.name === 'search_jobs' && JSON.stringify(r.result ?? null).includes('remoteFilter'));
    return searched && !/hybrid/i.test(text) ? `${text} These adverts mention remote or home working, and some may be hybrid, so check each one.` : text;
}

const ASKS_FOR_A_PROMISE = /\b(?:definitely|guarantee[ds]?|promise|for sure|for certain|certainly)\b[^.?!]*\b(?:visa|sponsor\w*)\b|\b(?:visa|sponsor\w*)\b[^.?!]*\b(?:definitely|guarantee[ds]?|promise|for sure|for certain)\b/i;

/** Asked for certainty about a visa, the first thing to say is that nobody has it. */
export function withNoPromise(text: string, message: string): string {
    if (!ASKS_FOR_A_PROMISE.test(message) || /\b(?:promise|guarantee|cannot say|can't say)\b/i.test(text)) return text;
    return `Nobody can promise a visa or sponsorship: the Home Office decides each application. ${text}`;
}

/** Someone in this state always sees where to get help, whatever the model wrote. */
export function withSupport(text: string, message: string): string {
    if (!HOPELESS.test(message) || /samaritans/i.test(text)) return text;
    return `${text} If things feel too much, you do not have to face this alone: Samaritans are on **116 123**, free, day or night, or call **999** if you are in danger.`;
}

/** Asking which investment to buy. The prompt handles any wording; this only guarantees the signpost for the common ones. */
const PICKS_INVESTMENT =
    /\b(?:which|what|best|good|should i (?:buy|invest)|recommend)\b[^.?!]{0,40}\b(?:shares?|stocks?|crypto\w*|coins?|bitcoin|tokens?|funds?|etfs?|invest\w*)\b/i;

/** Someone asking which investment to buy always sees where free, regulated guidance is. */
const CAREER_MONEY_WORDS = /\b(?:jobs?|roles?|careers?|cv|intern\w*|graduate|banking|bankers?|analysts?|traders?|interview\w*|employers?|vacanc\w*|controller|assistant)\b/i;

export function withMoneyHelp(text: string, message: string): string {
    if (!PICKS_INVESTMENT.test(message) || CAREER_MONEY_WORDS.test(message) || /moneyhelper/i.test(text)) return text;
    return `${text} For free, impartial guidance on your options and how to find a regulated financial adviser, see **MoneyHelper** (moneyhelper.org.uk), which is backed by the government.`;
}

const ANY_POUNDS = /£\s?(\d[\d,]*)(?:\.\d+)?\s?(k\b)?/gi;
const ASKS_PAY = /\b(?:earn|earns|earning|earnings|salary|salaries|paid|pay|wage|wages)\b/i;

/** What a job pays changes and is not in any data here unless a tool returned it, so a remembered figure is dropped. */
export function withoutGuessedPay<T extends { text: string; pieces: UiPiece[] }>(answer: T, message: string, evidenceText: string): T {
    if (!ASKS_PAY.test(message)) return answer;
    const evidence = evidenceText.replace(/(\d),(?=\d)/g, '$1');
    const guessed = (text: string) => [...text.matchAll(ANY_POUNDS)].some((m) => !evidence.includes(m[1]!.replace(/,/g, '') + (m[2] ? '000' : '')));
    const sentences = answer.text.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => !guessed(s));
    return {
        ...answer,
        text: kept.length === sentences.length ? answer.text : [...kept, 'I do not have a checked salary figure for this, so I will not guess. I can show live jobs that state their pay.'].join(' '),
        pieces: answer.pieces.filter((piece) => !guessed(JSON.stringify(piece))),
    };
}

const JOB_READING_TOOLS = new Set(['job_details', 'job_fit', 'recommend_jobs', 'search_jobs', 'compare_jobs']);
const JOB_FACT = /\b(?:requires?|involves?|asks? for|skills?|experience|responsibilit|salary|pay|good option|good fit|match)\b/i;

/** True when the text names a listed job and states something about it. */
export function describesListedJob(text: string, lists: JobListCard[]): boolean {
    if (!JOB_FACT.test(text)) return false;
    const lower = text.toLowerCase();
    return lists.some((list) => list.items.some((job) => lower.includes(job.title.toLowerCase()) && (!job.company || lower.includes(job.company.toLowerCase()))));
}

/** The card pairs each code with its title. "Chefs (2134)" in the AI's text can only agree or be wrong, so it goes. */
export function withoutBracketedCodes(text: string, shown: AgentBlock[]): string {
    const codes = new Set(shown.flatMap((b) => (b.kind === 'socCards' ? b.card.options.map((o) => o.code) : [])));
    return codes.size ? text.replace(/\s*\(\*{0,2}(\d{4})\*{0,2}\)/g, (whole, code: string) => (codes.has(code) ? '' : whole)) : text;
}

function words(value: string): string[] {
    return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2);
}

/** A paragraph that mostly repeats the answer text adds nothing, so it is dropped. */
export function repeats(piece: string, answerText: string): boolean {
    const pieceWords = words(piece);
    if (pieceWords.length < 4) return false;
    const answerWords = new Set(words(answerText));
    const shared = pieceWords.filter((w) => answerWords.has(w)).length;
    return shared / pieceWords.length >= 0.6;
}

function readOutput(body: unknown): string {
    const envelope = body as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: boolean }> } }> };
    return (
        envelope?.candidates?.[0]?.content?.parts
            ?.filter((part) => part.thought !== true && typeof part.text === 'string')
            .map((part) => part.text as string)
            .join('') ?? ''
    );
}

function parseStep(output: string): z.infer<typeof modelStepSchema> | null {
    try {
        const cleaned = firstJsonObject(output);
        if (!cleaned) return null;
        // Models often send `null` for unused fields; treat it as absent.
        const parsed = modelStepSchema.safeParse(JSON.parse(cleaned, (_key, value) => (value === null ? undefined : value)));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function boundedResult(value: unknown, max = MAX_TOOL_RESULT_CHARS): unknown {
    const json = JSON.stringify(value ?? null);
    return json.length <= max ? value : { truncatedPreview: json.slice(0, max) };
}

/**
 * Agent loop: the model either requests allow-listed tools or answers. Tool arguments are
 * validated, results go back as data, and the final answer is validated before streaming.
 */
export async function runAgent(
    input: AgentRunInput,
    sink: AgentEventSink,
    signal: AbortSignal,
    deps: AgentRunDeps = {},
): Promise<AgentRunResult> {
    const generate = deps.generate ?? executeAiGeneration;
    const allTools = deps.tools ?? AGENT_TOOLS;
    // Without a CV the CV tools are hidden, so general questions are answered instead of asking for a CV.
    // The template tool exists only while a tailored CV is on screen; otherwise the prompt says to use /cv first.
    const tools = allTools.filter((tool) => (input.cv || !CV_TOOL_NAMES.has(tool.name)) && (input.tailoredCv || tool.name !== CV_TEMPLATE_TOOL.name));
    const systemPrompt = buildSystemPrompt(tools);
    const toolResults: Array<{ name: string; ok: boolean; result?: unknown; error?: string }> = [];
    let toldToReadJob = false;
    let toldNotToRepeat = false;
    let toldToSearch = false;
    let toldToWrite = false;
    let toldToAsk = false;
    // A pasted job advert is data: its place, pay and words such as "visa" are not the user's request.
    // Every intent check below reads only the user's own words around it; the model still sees everything.
    const pasted = splitPastedAdvert(input.message);
    const asked = pasted ? pasted.ask : input.message;
    const interview = interviewState(input.history, asked);
    let toldToUseOfficialData = false;
    let toldNotToOpenWithYes = false;
    const calls: AgentAiCall[] = [];
    const blocks = new Map<string, AgentBlock>((input.preEmitted ?? []).map((b) => [b.id, b.block]));
    let writing = false;
    const seenCalls = new Set<string>();
    const toolsUsed: string[] = [];
    const timeShort = () => input.deadlineAt !== undefined && input.deadlineAt - Date.now() < ANSWER_RESERVE_MS;
    const cv = input.cv ?? null;
    const cvContext = cv ? cvContextSummary(cv) : null;
    // Decided by code: a question about the user's own CV with no CV chosen always shows the picker.
    const needsCv = !cv && isAboutOwnCv(asked);
    const showCvCard = isCvSummaryRequest(asked);
    const cvMatcher = cv ? new CvTextMatcher(cv.text) : null;
    const tailoredCvContext = input.tailoredCv
        ? { template: CV_TEMPLATE_CATALOGUE.find((t) => t.id === input.tailoredCv!.template)?.name ?? input.tailoredCv.template }
        : undefined;
    // A tool given up on may still finish later; what it shows then would arrive after the answer.
    let finished = false;
    const emit = (id: string, block: AgentBlock, options: { replace?: boolean } = {}) => {
        if (finished) return;
        if (blocks.has(id) && !options.replace) return;
        blocks.set(id, block);
        sink.send({ type: 'block', id, block });
    };
    // The answer card leads; supporting blocks (SOC, CV card, picker) follow it.
    const ordered = () => [...blocks.values()].sort((a, b) => Number(b.kind === 'answerCard') - Number(a.kind === 'answerCard'));
    const done = (answer: AgentAnswer | null, steps: number, failure?: AgentRunResult['failure']): AgentRunResult => (finished = true, {
        answer,
        steps,
        calls,
        blocks: ordered(),
        toolsUsed,
        ...(answer ? {} : { failure: failure ?? (signal.aborted ? 'cancelled' : 'no_answer') }),
    });

    sink.send({ type: 'status', id: 'think', label: 'Understanding your question', state: 'running' });
    // A CV overview always shows the CV card, decided by code rather than by whether the model calls a tool.
    if (cv && showCvCard) emit('cv-profile', { kind: 'cvProfile', card: cvProfileCard(cv) });

    // Official-rules and own-CV questions: code runs the right lookup first, so the answer is grounded in data.
    const forced = forcedToolCalls(asked, new Set(tools.map((t) => t.name)), { hasCv: Boolean(cv), pastedAdvert: Boolean(pasted) });
    if (forced.length) await runCalls(forced, 'forced');

    for (let step = 1; step <= MAX_AGENT_STEPS; step++) {
        if (signal.aborted) return done(null, step - 1);
        const mustAnswer = step === MAX_AGENT_STEPS || timeShort();
        const request = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [
                {
                    role: 'user',
                    parts: [{ text: buildStepMessage({
                            message: input.message,
                            history: input.history,
                            summary: input.summary,
                            cv: cvContext,
                            toolResults,
                            mustAnswer,
                            needsCv,
                            tailoredCv: tailoredCvContext,
                            shownCards: [...new Set([...blocks.values()].map((b) => b.kind).filter((k) => k !== 'answerCard' && k !== 'cvPicker'))],
                            caution: input.caution,
                            ...(interview ? { interview: interviewNote(interview) } : {}),
                            jobsOnScreen: jobListsNow().map((list, index) => ({ list: index, query: list.query, settings: { ...list.search, advert: undefined, ...(list.search.advert ? { fromPastedAdvert: true } : {}) }, jobs: list.items.map((j, i) => `${i + 1}. ${j.title}${j.company ? ` at ${j.company}` : ''}${j.location ? `, ${j.location}` : ''}`) })),
                        }) }],
                },
            ],
        };
        // One retry when the output is unreadable: cheap models occasionally degenerate.
        let parsed: z.infer<typeof modelStepSchema> | null = null;
        for (let attempt = 1; attempt <= MAX_PARSE_ATTEMPTS && !parsed; attempt++) {
            if (signal.aborted) return done(null, step);
            // Stop in time to still say something honest: the turn's deadline would otherwise end it with no reply.
            const timeLeft = input.deadlineAt === undefined ? Infinity : input.deadlineAt - Date.now() - DEADLINE_MARGIN_MS;
            const result = await generate('agent_turn', request, { signal, timeoutMs: Math.max(1000, Math.min(25_000, timeLeft)), maxTotalAttempts: timeShort() ? 1 : 2 });
            if (!result.ok) {
                // Cards already on screen are real data: keep them rather than replacing them with an error.
                if (![...blocks.values()].some((b) => b.kind !== 'cvPicker')) {
                    if (!JSON.stringify(toolResults).includes('SEARCH_SLOW')) return done(null, step, 'ai_error');
                    for (const delta of textDeltas(SEARCH_SLOW_TEXT)) sink.send({ type: 'text', delta });
                    return done({ text: SEARCH_SLOW_TEXT, pieces: [], suggestions: [] }, step);
                }
                const text = cardsOnlyText([...blocks.values()]);
                for (const delta of textDeltas(text)) sink.send({ type: 'text', delta });
                return done({ text, pieces: [], suggestions: [] }, step);
            }
            calls.push({
                step,
                model: result.model,
                promptTokens: result.diagnostics?.promptTokens,
                outputTokens: result.diagnostics?.outputTokens,
                latencyMs: result.latencyMs,
            });
            const output = readOutput(result.body);
            parsed = parseStep(output);
            // Shape only, never the text: enough to see why a reply could not be read.
            if (!parsed) console.warn('[agent] unreadable step', { step, attempt, chars: output.length, finishReason: result.diagnostics?.finishReason, hasJson: Boolean(firstJsonObject(output)) });
        }
        if (step === 1) sink.send({ type: 'status', id: 'think', label: 'Understanding your question', state: 'done' });
        if (!parsed) {
            // Cards already on screen are real data: keep them rather than replacing them with an error.
            if (![...blocks.values()].some((b) => b.kind !== 'cvPicker')) return done(null, step, 'unreadable');
            const text = cardsOnlyText([...blocks.values()]);
            for (const delta of textDeltas(text)) sink.send({ type: 'text', delta });
            return done({ text, pieces: [], suggestions: [] }, step);
        }

        // Saying the last answer again ignores what was just asked: send the model back once.
        if (parsed.answer && !parsed.toolCalls?.length && !mustAnswer && !toldNotToRepeat && repeatsLastAnswer(parsed.answer.text, input.history)) {
            toldNotToRepeat = true;
            toolResults.push({ name: 'answer_this_message', ok: false, error: 'That repeats your previous answer. Answer the newest user message only, using the tool results for it.' });
            continue;
        }
        // Told once and still repeating: an old answer can name jobs that are not on screen now. With new cards
        // on screen, the plain line about them is the honest answer.
        if (parsed.answer && !parsed.toolCalls?.length && toldNotToRepeat && repeatsLastAnswer(parsed.answer.text, input.history) && [...blocks.values()].some((b) => b.kind === 'jobList')) {
            parsed.answer = { ...parsed.answer, text: cardsOnlyText([...blocks.values()]), ui: [] };
        }
        // "No jobs" without looking is a guess: send the model back to search once.
        if (parsed.answer && !parsed.toolCalls?.length && !mustAnswer && !toldToSearch && !toolsUsed.includes('search_jobs') && CLAIMS_NO_JOBS.test(parsed.answer.text)) {
            toldToSearch = true;
            toolResults.push({ name: 'search_first', ok: false, error: 'You said no jobs were found without searching. Call search_jobs now with what they asked for.' });
            continue;
        }
        // Visa rules come from official data, never memory: code looks them up, and the model answers again from the result.
        if (parsed.answer && !parsed.toolCalls?.length && !mustAnswer && !toldToUseOfficialData && !SMALL_TALK.test(asked.trim()) && asksAboutSoc(asked) && !toolsUsed.some((t) => OFFICIAL_OR_JOB_TOOLS.has(t)) && MENTIONS_VISA_RULES.test(parsed.answer.text)) {
            toldToUseOfficialData = true;
            toolResults.push({ name: 'use_official_data', ok: false, error: 'You wrote about visas without official data, so that answer was discarded. Answer only from the official results here. If soc_lookup found no job in the message, ignore it.' });
            parsed.toolCalls = [{ name: 'gov_uk_guidance', args: { question: asked.slice(0, 2000) } }, ...(NAMES_A_JOB.test(asked) ? [{ name: 'soc_lookup', args: { query: asked.slice(0, 400) } }] : [])];
            parsed.answer = undefined;
        }
        // "Yes" to a visa question hides any limit the rules put on it: check the job's own rules, and lead with what applies today.
        if (parsed.answer && !parsed.toolCalls?.length && !mustAnswer && !toldNotToOpenWithYes && /^\s*yes\b/i.test(parsed.answer.text) && MENTIONS_VISA_RULES.test(parsed.answer.text) && !toolsUsed.includes('find_sponsors') && toolsUsed.some((t) => t === 'gov_uk_guidance' || t === 'soc_lookup')) {
            toldNotToOpenWithYes = true;
            toolResults.push({ name: 'state_the_rule_first', ok: false, error: 'Do not start with "Yes". Start with what the rules in force today allow for this person\'s situation, including any limit such as having to apply from inside the UK. Use only the official results here.' });
            if (!toolsUsed.includes('soc_lookup') && NAMES_A_JOB.test(asked)) {
                parsed.toolCalls = [{ name: 'soc_lookup', args: { query: asked.slice(0, 400) } }];
                parsed.answer = undefined;
            } else {
                continue;
            }
        }
        // A job's requirements come from its advert, never memory: send the model back to read it once.
        if (parsed.answer && !parsed.toolCalls?.length && !mustAnswer && !toolsUsed.some((t) => JOB_READING_TOOLS.has(t)) && !toldToReadJob && describesListedJob(parsed.answer.text, jobListsNow())) {
            toldToReadJob = true;
            toolResults.push({ name: 'read_the_advert', ok: false, error: 'You described a listed job without reading it. Call job_details, job_fit or recommend_jobs now and answer only from the result.' });
            continue;
        }
        // A search that ran out of time found nothing yet; "no jobs" or "couldn't find" would be false. Say only that it was slow.
        // Any other answer (a cover letter written while the search was slow) is kept.
        if (parsed.answer && (!parsed.toolCalls?.length || mustAnswer) && searchTimedOut() && ![...blocks.values()].some((b) => b.kind === 'jobList') && CLAIMS_NO_JOBS.test(parsed.answer.text)) {
            // A letter or other written piece is still what they asked for: only the false "no jobs" sentences go.
            const wrotePiece = parsed.answer.ui.some((piece) => (piece as { type?: unknown })?.type === 'example');
            const rest = parsed.answer.text.split(/(?<=[.!?])\s+/).filter((sentence) => !CLAIMS_NO_JOBS.test(sentence)).join(' ');
            parsed.answer = wrotePiece ? { ...parsed.answer, text: `${SEARCH_SLOW_TEXT} ${rest}`.trim() } : { ...parsed.answer, text: SEARCH_SLOW_TEXT, ui: [] };
        }
        if (parsed.answer && (!parsed.toolCalls?.length || mustAnswer)) {
            const cleaned = cleanAnswer(JSON.parse(withoutDateStatus(JSON.stringify(parsed.answer))) as typeof parsed.answer, (text) => Boolean(cvMatcher?.contains(text)));
            const answer = withoutGuessedPay(withoutUnverifiedFigures(
                { ...cleaned, text: withMoneyHelp(withNoPromise(withRemoteNote(withSupport(withoutLicenceYes(withoutPromise(withoutOverclaim(withoutBracketedCodes(cleaned.text, [...blocks.values()]), JSON.stringify(toolResults))), asked), asked), toolResults), asked), asked), pieces: withoutCardRepeats(cleaned.pieces, [...blocks.values()]) },
                `${input.message} ${JSON.stringify(toolResults)}`,
                [...blocks.values()].some((b) => b.kind === 'socCards' || b.kind === 'officialFacts'),
            ), asked, `${input.message} ${JSON.stringify(toolResults)}`);
            // "Here's a draft" with no draft: send the model back once to write it.
            if (!mustAnswer && !toldToWrite && asksToWrite(asked) && !answer.pieces.some((piece) => piece.type === 'example') && answer.text.length < 700) {
                toldToWrite = true;
                toolResults.push({ name: 'write_it_now', ok: false, error: 'They asked you to write it and it is not in your answer. Put the full text in an example piece now, from their CV and what you know of the job, with [brackets] for anything unknown. Use no pay figure.' });
                continue;
            }
            // A mock interview that forgot its next question: send the model back once to ask it.
            if (!mustAnswer && !toldToAsk && interview && !asksInterviewQuestion(answer.text, interview)) {
                toldToAsk = true;
                toolResults.push({ name: 'ask_next_question', ok: false, error: `Your text does not ask the next interview question. Rewrite the answer and end "text" with **Question ${interview.next} of ${interview.total}:** and the question itself, in text, not in ui. Do not ask which job first.` });
                continue;
            }
            if (writing) sink.send({ type: 'status', id: 'write', label: 'Writing your answer', state: 'done' });
            for (const delta of textDeltas(answer.text)) sink.send({ type: 'text', delta });
            if (answer.pieces.length) emit('answer', { kind: 'answerCard', pieces: answer.pieces });
            // A request about the tailored CV's look is not a question about the user's CV: no picker.
            const changedTemplate = toolsUsed.includes(CV_TEMPLATE_TOOL.name);
            if (!changedTemplate && (needsCv || (!cv && ASKS_FOR_CV.test(answer.text)))) emit('cv-picker', { kind: 'cvPicker' });
            if (answer.suggestions.length) sink.send({ type: 'suggestions', items: answer.suggestions });
            return done(answer, step);
        }
        if (!parsed.toolCalls?.length) {
            // Cards already on screen are real data: keep them rather than replacing them with an error.
            if (![...blocks.values()].some((b) => b.kind !== 'cvPicker')) return done(null, step);
            const text = cardsOnlyText([...blocks.values()]);
            for (const delta of textDeltas(text)) sink.send({ type: 'text', delta });
            return done({ text, pieces: [], suggestions: [] }, step);
        }

        await runCalls(parsed.toolCalls, `tool-${step}`);
        if (!writing) sink.send({ type: 'status', id: 'write', label: 'Writing your answer', state: 'running' });
        writing = true;
    }
    // Out of steps with cards on screen: they are real data, so keep them rather than showing an error.
    if ([...blocks.values()].some((b) => b.kind !== 'cvPicker')) {
        const text = cardsOnlyText([...blocks.values()]);
        for (const delta of textDeltas(text)) sink.send({ type: 'text', delta });
        return done({ text, pieces: [], suggestions: [] }, MAX_AGENT_STEPS);
    }
    return done(null, MAX_AGENT_STEPS);

    /** A job search in this turn that ended because the ranking ran out of time. */
    function searchTimedOut(): boolean {
        return toolResults.some((r) => r.name === 'search_jobs' && r.ok && JSON.stringify(r.result ?? '').includes('SEARCH_SLOW'));
    }

    /** This turn's list first, then earlier ones: the numbers on screen. */
    function jobListsNow(): JobListCard[] {
        return nextJobLists(input.jobLists ?? [], blocks.values());
    }

    /** Runs allow-listed tools with validated arguments; shared by code-decided and model-requested calls. */
    async function runCalls(toolCalls: Array<{ name: string; args: Record<string, unknown> }>, idPrefix: string): Promise<void> {
        for (const [index, call] of toolCalls.entries()) {
            const id = `${idPrefix}-${index}`;
            if (toolsUsed.length >= MAX_TOOL_CALLS_PER_TURN || timeShort()) {
                toolResults.push({ name: call.name, ok: false, error: 'No more lookups this turn. Answer with what you have.' });
                continue;
            }
            const tool = findTool(call.name, tools);
            if (!tool) {
                toolResults.push({ name: call.name, ok: false, error: 'Unknown tool. Answer without it.' });
                continue;
            }
            // Each search is slow, and a second one in a turn runs out of time with no answer at all.
            if (call.name === 'search_jobs' && toolsUsed.includes('search_jobs')) {
                toolResults.push({ name: call.name, ok: false, error: 'Do not search here. Answer from what you already have.' });
                continue;
            }
            if ((call.name === 'soc_lookup' || call.name === 'visa_salary_rules') && !toldToUseOfficialData && !asksAboutSoc(asked, input.history.slice(-2).map((turn) => turn.text))) {
                toolResults.push({ name: call.name, ok: false, error: 'The user did not ask about SOC codes or visas. Answer what they asked, without SOC codes.' });
                continue;
            }
            const args = tool.args.safeParse(call.args);
            if (!args.success) {
                // Say what was wrong, so the model can correct the call instead of telling the user something failed.
                const wrong = args.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`).join('; ');
                toolResults.push({ name: call.name, ok: false, error: `Invalid arguments (${wrong}). Correct them and call it again. Never tell the user about this.` });
                continue;
            }
            // The same tool with the same arguments in one turn runs once: saves cost and stops loops.
            const callKey = `${call.name}:${JSON.stringify(args.data)}`;
            if (seenCalls.has(callKey)) {
                toolResults.push({ name: call.name, ok: true, result: { note: 'Same call already made this turn; use the earlier result.' } });
                continue;
            }
            seenCalls.add(callKey);
            toolsUsed.push(call.name);
            sink.send({ type: 'status', id, label: tool.label(args.data), state: 'running' });
            try {
                const running = tool.run(args.data, { uid: input.uid, signal, cv, emit, showCvCard, userMessage: asked, ...(input.tailoredCv ? { tailoredCv: input.tailoredCv } : {}), ...(pasted ? { advert: pasted.advert } : {}), lastJobs: jobListsNow()[0], jobLists: jobListsNow() });
                // A tool given up on may still fail later; that failure is no longer anyone's to handle.
                running.catch(() => undefined);
                const timeLeft = input.deadlineAt === undefined ? undefined : input.deadlineAt - Date.now() - TOOL_RESERVE_MS;
                let value: unknown;
                try {
                    value = timeLeft === undefined ? await running : await withinMs(running, Math.max(1_000, timeLeft), 'Tool');
                } catch (error) {
                    // Out of time: a search says only that it was slow; any other tool counts as unavailable.
                    if (call.name !== 'search_jobs' || signal.aborted || !/took longer/.test((error as Error).message)) throw error;
                    value = SLOW_SEARCH_RESULT;
                }
                toolResults.push({ name: call.name, ok: true, result: boundedResult(value, tool.maxResultChars) });
                sink.send({ type: 'status', id, label: tool.label(args.data), state: 'done' });
            } catch {
                // Tool errors stay generic: no internals or data identifiers reach the model or client.
                toolResults.push({ name: call.name, ok: false, error: 'This source is unavailable right now.' });
                sink.send({ type: 'status', id, label: tool.label(args.data), state: 'failed' });
            }
        }
    }
}
