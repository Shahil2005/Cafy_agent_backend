import type { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { isBillingEnabled } from '../billing/config';
import { getUserBillingDoc, isJobsPremiumActive } from '../billing/subscriptionService';
import { runAgent, type AgentRunDeps } from './agent';
import { agentTurnRequestSchema, type AgentBlock } from './contract';
import {
    appendMessages,
    withoutLastPair,
    firestoreConversationStore,
    recentJobLists,
    newConversation,
    type Conversation,
    type ConversationStore,
} from './conversations';
import { CvIndexError, describeCvError, firestoreCvStore, indexCv, type CvIndex, type CvStore } from './cv';
import type { EmbedFn } from './cv/embed';
import { CvProfileError, NotCvError, type extractCvProfile } from './cv/profile';
import { gateMessage } from './gate';
import { consumeDaily } from './limits';
import { acquireTurnLock } from './lock';
import { recentHistory, refreshSummary } from './memory';
import { openSse, textDeltas, type AgentEventSink } from './sse';
import { cvProfileCard } from './tools/cv';
import { getJobsPortalRedis } from '../jobs-portal/redisClient';
import { logAgentUsage, recordDailyUsage, type AgentAiCall, type UsageStore } from './usage';

const BLOCKED_SUGGESTIONS = ['Help me improve my CV', 'Find graduate jobs in the UK', 'How do I prepare for an interview?'];
const CONVERSATION_ID = /^[A-Za-z0-9]{10,40}$/;
/** Whole turn budget, under Vercel's 60 s function cap so the answer always arrives. */
const TURN_DEADLINE_MS = 50_000;
/** Time a final answer needs; with less left after reading a new CV, the CV card is the reply. */
const CV_ANSWER_RESERVE_MS = 15_000;
/** The rolling summary runs after `done` and must also finish before the function cap. */
const SUMMARY_GRACE_MS = 7_000;

interface HandlerDeps extends AgentRunDeps {
    /** Read-only plan check; tests inject a stub. */
    hasAccess?: (uid: string) => Promise<boolean>;
    consume?: typeof consumeDaily;
    conversations?: ConversationStore;
    cvStore?: CvStore;
    embed?: EmbedFn;
    extractCv?: typeof extractCvProfile;
    lock?: typeof acquireTurnLock;
    /** Daily totals store; null turns totals off (tests). */
    usageStore?: UsageStore | null;
    turnDeadlineMs?: number;
}

/** Reads the user's subscription only; never writes to Firestore. */
export async function hasAgentAccess(uid: string): Promise<boolean> {
    if (!isBillingEnabled()) return true;
    const snapshot = await admin.firestore().doc(`users/${uid}`).get();
    const { subscription } = await getUserBillingDoc(uid, snapshot);
    return isJobsPremiumActive(subscription);
}

function userId(req: Request): string | undefined {
    return (req as Request & { user?: { uid?: string } }).user?.uid;
}

const CV_STEPS = {
    read: 'Reading every page of your CV',
    understand: 'Understanding your experience and skills',
    index: 'Indexing your CV so I can search all of it',
} as const;

/** Indexes a newly chosen CV with live steps; returns null (after an error event) if it cannot be read. */
async function selectCv(
    uid: string,
    cv: { name: string; text: string },
    sink: AgentEventSink,
    signal: AbortSignal,
    deps: HandlerDeps,
    calls: AgentAiCall[],
): Promise<CvIndex | null> {
    try {
        const result = await indexCv(uid, cv, {
            signal,
            store: deps.cvStore,
            embed: deps.embed,
            extract: deps.extractCv,
            progress: (step, state) => sink.send({ type: 'status', id: `cv-${step}`, label: CV_STEPS[step], state }),
        });
        if (result.cached) sink.send({ type: 'status', id: 'cv-cached', label: 'Using your saved CV analysis', state: 'done' });
        calls.push(...result.calls);
        return result.index;
    } catch (error) {
        // Failed AI attempts still cost money, so they are counted.
        const cause = error instanceof CvIndexError ? error.cause : undefined;
        if (cause instanceof CvProfileError) calls.push(...(cause.details.calls ?? []));
        if (cause instanceof NotCvError) {
            // Not an error: the file is readable but is not a CV. Nothing was stored.
            calls.push(...cause.calls);
            const looksLike = cause.looksLike ? ` (it looks like ${/^[aeiou]/i.test(cause.looksLike) ? 'an' : 'a'} ${cause.looksLike.toLowerCase()})` : '';
            sink.send({ type: 'status', id: 'cv-understand', label: CV_STEPS.understand, state: 'done' });
            sink.send({ type: 'text', delta: `This file doesn't look like a CV${looksLike}. Please choose a CV from your profile, or add one in your profile first.` });
            sink.send({ type: 'block', id: 'cv-picker', block: { kind: 'cvPicker' } });
            sink.send({ type: 'done', steps: 0 });
            return null;
        }
        // Stopped or out of time: the handler reports it, not as an unreadable CV.
        if (signal.aborted) return null;
        // Step and error type only: never the CV text.
        console.warn('[agent] CV indexing failed', describeCvError(error));
        sink.send({
            type: 'error',
            code: 'CV_UNREADABLE',
            message: 'I could not read that CV right now. Please try again, or choose another CV from your profile.',
            retryable: true,
        });
        return null;
    }
}

export function createAgentTurnHandler(deps: HandlerDeps = {}) {
    const conversations = deps.conversations ?? firestoreConversationStore;
    const cvStore = deps.cvStore ?? firestoreCvStore;
    return async (req: Request, res: Response): Promise<void> => {
        res.setHeader('Cache-Control', 'no-store');
        const uid = userId(req);
        if (!uid) {
            res.status(401).json({ error: 'UNAUTHORIZED', message: 'Please sign in to chat with CAFY.' });
            return;
        }
        const input = agentTurnRequestSchema.safeParse(req.body);
        if (!input.success) {
            res.status(400).json({ error: 'INVALID_INPUT', message: 'Please send a message of up to 8,000 characters.' });
            return;
        }
        try {
            if (!(await (deps.hasAccess ?? hasAgentAccess)(uid))) {
                res.status(403).json({ error: 'PLAN_REQUIRED', message: 'Chat with CAFY is part of the jobs premium plan.' });
                return;
            }
        } catch {
            res.status(503).json({ error: 'INTERNAL', message: 'We could not check your plan. Please try again.' });
            return;
        }
        const lock = await (deps.lock ?? acquireTurnLock)(uid);
        if (!lock.acquired) {
            res.status(409).json({ error: 'BUSY', message: "I'm still answering your last message. Please wait for it to finish." });
            return;
        }
        const consume = deps.consume ?? consumeDaily;
        const turns = await consume(uid, 'turns').catch(async (error: unknown) => {
            await lock.release();
            throw error;
        });
        if (!turns.allowed) {
            await lock.release();
            res.status(429).json({ error: 'LIMIT_REACHED', message: 'You have reached today\'s chat limit. It resets at midnight UK time.' });
            return;
        }

        const deadlineMs = deps.turnDeadlineMs ?? TURN_DEADLINE_MS;
        const deadlineAt = Date.now() + deadlineMs;
        const caller = new AbortController();
        const deadline = setTimeout(() => caller.abort(), deadlineMs);
        const timedOut = () => Date.now() >= deadlineAt;
        const disconnect = () => {
            if (!res.writableEnded) caller.abort();
        };
        req.once('aborted', disconnect);
        res.once('close', disconnect);
        const sink = openSse(res);
        const calls: AgentAiCall[] = [];
        let toolsUsed: string[] = [];
        let outcome = 'failed';

        try {
            const { message, conversationId, cv: pickedCv, regenerate } = input.data;
            const gate = gateMessage(message);
            if (!gate.allowed) {
                sink.send({ type: 'text', delta: gate.message });
                sink.send({ type: 'suggestions', items: BLOCKED_SUGGESTIONS });
                sink.send({ type: 'done', steps: 0 });
                outcome = `blocked:${gate.reason}`;
                return;
            }

            let conversation: Conversation | null = conversationId ? await conversations.get(uid, conversationId) : null;
            if (!conversation) {
                conversation = newConversation(message);
                sink.send({ type: 'conversation', id: conversation.id, title: conversation.title });
            }

            let cv: CvIndex | null = null;
            const preEmitted: Array<{ id: string; block: AgentBlock }> = [];
            if (pickedCv) {
                cv = await selectCv(uid, pickedCv, sink, caller.signal, deps, calls);
                if (!cv) {
                    if (timedOut()) {
                        outcome = 'timeout';
                        sink.send({ type: 'error', code: 'AI_UNAVAILABLE', message: 'Reading that CV took longer than expected. Please choose it again.', retryable: true });
                    }
                    return;
                }
                conversation = { ...conversation, cvHash: cv.hash, cvName: cv.name };
                const card: AgentBlock = { kind: 'cvProfile', card: cvProfileCard(cv) };
                sink.send({ type: 'block', id: 'cv-profile', block: card });
                preEmitted.push({ id: 'cv-profile', block: card });
            } else if (conversation.cvHash) {
                cv = await cvStore.get(uid, conversation.cvHash);
                if (!cv) {
                    // The saved analysis expired or the CV was deleted: say so, and let the user pick again.
                    conversation = { ...conversation, cvHash: undefined, cvName: undefined };
                    sink.send({ type: 'cv', name: null });
                    sink.send({ type: 'status', id: 'cv-expired', label: 'Your saved CV analysis is no longer available: choose your CV again', state: 'failed' });
                    preEmitted.push({ id: 'cv-picker', block: { kind: 'cvPicker' } });
                    sink.send({ type: 'block', id: 'cv-picker', block: { kind: 'cvPicker' } });
                } else if (conversation.cvName) cv = { ...cv, name: conversation.cvName };
            }

            // Reading a long CV used most of the time: the CV card is the reply, with no extra AI call.
            // Choosing a CV is not a question: the same reply, so a long CV cannot fail or spend an AI call here.
            const onlyChoosingCv = /^use my cv\b/i.test(message);
            const cvReadyOnly = Boolean(pickedCv && cv) && (onlyChoosingCv || deadlineAt - Date.now() < CV_ANSWER_RESERVE_MS);
            const run = cvReadyOnly
                ? {
                      answer: {
                          text: 'Your CV is ready: I have read every page. Ask me anything about it.',
                          pieces: [],
                          suggestions: ['Give me jobs for my CV', 'Summarise my CV', 'Which SOC code fits my CV?', 'How many years of experience do I have?'],
                      },
                      blocks: preEmitted.map((b) => b.block),
                      steps: 0,
                      calls: [],
                      toolsUsed: [],
                  }
                : await runAgent(
                      {
                          uid,
                          message,
                          history: recentHistory(conversation),
                          summary: conversation.summary,
                          cv,
                          preEmitted,
                          deadlineAt,
                          caution: gate.caution,
                          jobLists: recentJobLists(conversation),
                      },
                      sink,
                      caller.signal,
                      deps,
                  );
            if (cvReadyOnly && run.answer) {
                for (const delta of textDeltas(run.answer.text)) sink.send({ type: 'text', delta });
                sink.send({ type: 'suggestions', items: run.answer.suggestions });
            }
            calls.push(...run.calls);
            toolsUsed = run.toolsUsed;
            if (caller.signal.aborted) {
                if (timedOut()) {
                    outcome = 'timeout';
                    sink.send({ type: 'error', code: 'AI_UNAVAILABLE', message: 'That took longer than expected. Please try again.', retryable: true });
                } else outcome = 'cancelled';
                return;
            }
            if (!run.answer) {
                outcome = `failed:${run.failure ?? 'no_answer'}`;
                sink.send({ type: 'error', code: 'AI_UNAVAILABLE', message: 'I could not finish that answer. Please try again.', retryable: true });
                return;
            }
            const now = Date.now();
            const turn = [
                { role: 'user' as const, text: message, at: now },
                { role: 'assistant' as const, text: run.answer.text, blocks: run.blocks, suggestions: run.answer.suggestions, at: now },
            ];
            // Re-read just before saving so a turn from another tab is never overwritten.
            const latest = (await conversations.get(uid, conversation.id)) ?? conversation;
            const base: Conversation = { ...latest, cvHash: conversation.cvHash, cvName: conversation.cvName };
            conversation = appendMessages(regenerate ? withoutLastPair(base, message) : base, turn);
            await conversations.put(uid, conversation);
            const answerIndex = conversation.messages.filter((m) => m.role === 'assistant').length - 1;
            sink.send({ type: 'done', steps: run.steps, answerIndex });
            outcome = 'answered';

            // After `done`: the client has its answer and may send its next message now, so the lock is freed
            // and a slow summary never delays the user.
            clearTimeout(deadline);
            await lock.release();
            const summary = await refreshSummary(conversation, {
                signal: AbortSignal.timeout(Math.max(1_000, deadlineAt + SUMMARY_GRACE_MS - Date.now())),
                generate: deps.generate,
            });
            if (summary.call) {
                calls.push(summary.call);
                // Saved only if no newer turn was saved meanwhile; otherwise the next turn refreshes it.
                const latest = await conversations.get(uid, conversation.id);
                if (latest?.updatedAt === conversation.updatedAt) await conversations.put(uid, summary.conversation);
            }
        } catch {
            // Never log the message, CV or provider errors: they can contain personal data.
            sink.send({ type: 'error', code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true });
        } finally {
            clearTimeout(deadline);
            await lock.release();
            if (calls.length) await consume(uid, 'aiCalls', calls.length).catch(() => undefined);
            logAgentUsage(calls, outcome);
            await recordDailyUsage(calls, outcome, toolsUsed, deps.usageStore === undefined ? (getJobsPortalRedis() as UsageStore | null) : deps.usageStore);
            req.removeListener('aborted', disconnect);
            res.removeListener('close', disconnect);
            if (!res.writableEnded) res.end();
        }
    };
}

export const handleAgentTurn = createAgentTurnHandler();

/** Lists, opens and deletes the user's own conversations (agentConversations only). */
export function createConversationHandlers(store: ConversationStore = firestoreConversationStore) {
    const guard = (req: Request, res: Response): { uid: string; id?: string } | null => {
        res.setHeader('Cache-Control', 'no-store');
        const uid = userId(req);
        if (!uid) {
            res.status(401).json({ error: 'UNAUTHORIZED' });
            return null;
        }
        const id = req.params.id;
        if (id !== undefined && !CONVERSATION_ID.test(id)) {
            res.status(400).json({ error: 'INVALID_INPUT' });
            return null;
        }
        return { uid, id };
    };
    return {
        async list(req: Request, res: Response) {
            const ctx = guard(req, res);
            if (!ctx) return;
            try {
                res.json({ conversations: await store.list(ctx.uid, 30) });
            } catch {
                res.status(503).json({ error: 'INTERNAL' });
            }
        },
        async get(req: Request, res: Response) {
            const ctx = guard(req, res);
            if (!ctx?.id) return;
            try {
                const conversation = await store.get(ctx.uid, ctx.id);
                if (!conversation) {
                    res.status(404).json({ error: 'NOT_FOUND' });
                    return;
                }
                res.json({
                    id: conversation.id,
                    title: conversation.title,
                    cvName: conversation.cvName,
                    messages: conversation.messages.map(({ role, text, blocks, suggestions }) => ({ role, text, blocks, suggestions })),
                });
            } catch {
                res.status(503).json({ error: 'INTERNAL' });
            }
        },
        async remove(req: Request, res: Response) {
            const ctx = guard(req, res);
            if (!ctx?.id) return;
            try {
                await store.remove(ctx.uid, ctx.id);
                res.status(204).end();
            } catch {
                res.status(503).json({ error: 'INTERNAL' });
            }
        },
    };
}

export const conversationHandlers = createConversationHandlers();
