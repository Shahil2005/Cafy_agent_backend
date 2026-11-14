import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as admin from 'firebase-admin';
import { getCompanySiteUrl } from './config';
import { markUnsubscribed } from './userStub';
import { verifyUnsubscribeToken } from './unsubscribe';

const feedbackSchema = z.object({
    reason: z.string().trim().max(80).optional(),
    user_id: z.string().trim().max(128).optional(),
    email: z.string().trim().email().max(320).optional().or(z.literal('')),
    comment: z.string().trim().max(2000).optional(),
});

export function createEmailRouter(): Router {
    const router = Router();

    async function handleUnsubscribe(req: Request, res: Response): Promise<void> {
        const token = typeof req.query.token === 'string' ? req.query.token : typeof req.body?.token === 'string' ? req.body.token : '';
        const uid = verifyUnsubscribeToken(token);
        const dest = `${getCompanySiteUrl()}/preferences`;

        if (!uid) {
            res.redirect(302, `${dest}?error=invalid`);
            return;
        }

        try {
            await markUnsubscribed(uid);
            res.redirect(302, `${dest}?unsubscribed=1`);
        } catch (err) {
            console.error('[email] unsubscribe failed', err);
            res.redirect(302, `${dest}?error=failed`);
        }
    }

    router.get('/unsubscribe', handleUnsubscribe);
    router.post('/unsubscribe', handleUnsubscribe);

    router.post('/feedback', async (req: Request, res: Response) => {
        const parsed = feedbackSchema.safeParse(req.body || {});
        if (!parsed.success) {
            res.status(400).json({ error: 'INVALID_INPUT' });
            return;
        }

        const { reason, user_id, email, comment } = parsed.data;
        await admin.firestore().collection('emailFeedback').add({
            reason: reason || null,
            uid: user_id || null,
            email: email || null,
            comment: comment || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null,
        });

        res.status(200).json({ ok: true });
    });

    return router;
}
