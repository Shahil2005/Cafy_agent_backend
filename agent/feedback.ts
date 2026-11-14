import type { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { z } from 'zod';

/** Thumbs up/down on an answer. Stored only at users/{uid}/agentFeedback (a new path); never the answer text. */
export const feedbackSchema = z.object({
    conversationId: z.string().regex(/^[A-Za-z0-9]{10,40}$/),
    /** Position of the answer in the conversation (0-based, assistant messages only). */
    answerIndex: z.number().int().min(0).max(500),
    rating: z.enum(['up', 'down']),
    reason: z.enum(['wrong', 'not_useful', 'too_long', 'other']).optional(),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type FeedbackStore = (uid: string, entry: FeedbackInput & { at: number; expiresAt: number }) => Promise<void>;

/** Ratings are kept for a year to measure answer quality, then deleted by the retention job. */
const FEEDBACK_RETENTION_DAYS = 365;

const firestoreFeedback: FeedbackStore = async (uid, entry) => {
    // One document per answer: a changed vote overwrites the user's own earlier vote.
    const id = `${entry.conversationId}_${entry.answerIndex}`;
    await admin.firestore().collection('users').doc(uid).collection('agentFeedback').doc(id).set(entry);
};

export function createFeedbackHandler(store: FeedbackStore = firestoreFeedback) {
    return async (req: Request, res: Response): Promise<void> => {
        const uid = (req as Request & { user?: { uid?: string } }).user?.uid;
        if (!uid) {
            res.status(401).json({ error: 'UNAUTHORIZED' });
            return;
        }
        const input = feedbackSchema.safeParse(req.body);
        if (!input.success) {
            res.status(400).json({ error: 'INVALID_INPUT' });
            return;
        }
        try {
            const at = Date.now();
            await store(uid, { ...input.data, at, expiresAt: at + FEEDBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000 });
            res.status(204).end();
        } catch {
            res.status(503).json({ error: 'INTERNAL' });
        }
    };
}

export const handleAgentFeedback = createFeedbackHandler();
