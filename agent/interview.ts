import type { AgentHistoryTurn } from './contract';

/**
 * Mock interviews run in the chat itself: the agent asks "Question N of M" and the user answers.
 * Code keeps count from the conversation so the model never loses its place or forgets to go on.
 */

export const DEFAULT_QUESTIONS = 5;
const QUESTION_MARK = /\bquestion\s*(\d{1,2})\s*of\s*(\d{1,2})\b/gi;
const STOP = /^\s*(?:stop|end|finish|quit|that'?s (?:enough|all)|no more|i'?m done|let'?s stop)\b/i;

/** "Interview me", "mock interview", "practise the interview": the first question belongs in this answer. */
export function startsMockInterview(message: string): boolean {
    if (/\b(?:what|which|likely|common|typical)\b[^.?!]{0,30}\bquestions?\b/i.test(message)) return false;
    return /\b(?:mock interview|interview me|practi[cs]e (?:the |an |my |a )?interview|interview practi[cs]e|practi[cs]e for (?:the |an |my |a )?interview)\b/i.test(message);
}

export interface InterviewState {
    /** The question number the user is now answering (0 when starting). */
    asked: number;
    total: number;
    /** The question to ask in this answer, if any. */
    next?: number;
    /** True when this answer must wrap up with a summary. */
    finish: boolean;
}

/** Where a mock interview stands, from the last assistant message; null when none is running or starting. */
export function interviewState(history: AgentHistoryTurn[], message: string): InterviewState | null {
    const last = [...history].reverse().find((turn) => turn.role === 'assistant');
    const marks = last ? [...last.text.matchAll(QUESTION_MARK)] : [];
    const mark = marks[marks.length - 1];
    if (mark) {
        const asked = Number(mark[1]);
        const total = Math.max(asked, Number(mark[2]));
        // A new request ("interview me for job 3") starts again rather than carrying on.
        if (startsMockInterview(message)) return { asked: 0, total: DEFAULT_QUESTIONS, next: 1, finish: false };
        if (STOP.test(message) || asked >= total) return { asked, total, finish: true };
        return { asked, total, next: asked + 1, finish: false };
    }
    return startsMockInterview(message) ? { asked: 0, total: DEFAULT_QUESTIONS, next: 1, finish: false } : null;
}

/** The note the model reads this turn. */
export function interviewNote(state: InterviewState): string {
    if (state.asked === 0) return `Start the mock interview now: one sentence on how it works, then ask **Question 1 of ${state.total}:** in text. No ui.`;
    if (state.finish)
        return `The mock interview is over. The user's message answers question ${state.asked} (or asks to stop). Give brief feedback on it if it is an answer, then a summary: their strongest point, two things to improve, and one next step. Ask no more questions.`;
    return `Mock interview in progress. The user's message is their answer to question ${state.asked}. Give short feedback (what worked; what is missing under STAR), and a stronger version in one example piece that uses ONLY what they said or their CV shows, with [brackets] for any missing detail such as a result or number; never add actions, tools or results they did not mention. Then end your text with **Question ${state.next} of ${state.total}:** and the next question. If they asked something else instead of answering, answer it and then repeat question ${state.asked}.`;
}

/** The answer asks the question it should, so the interview never stalls. */
export function asksInterviewQuestion(text: string, state: InterviewState): boolean {
    if (!state.next) return true;
    return new RegExp(`\\bquestion\\s*${state.next}\\b`, 'i').test(text) || (state.asked > 0 && new RegExp(`\\bquestion\\s*${state.asked}\\b`, 'i').test(text));
}
