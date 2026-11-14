import type { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import { parseGaLink, saveGaLink, sendGaEvent } from './ga4';

const ACTIVATION_TYPES = new Set(['job_saved', 'cv_uploaded', 'cv_created']);
const SIGN_UP_METHODS = new Set(['email', 'google']);
// A sign_up is only accepted for accounts created recently, so an old account cannot report one.
const SIGN_UP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/analytics/event (signed in)
 * Body: { event: 'link' | 'sign_up' | 'activation', ga: { clientId, sessionId }, method?, activationType? }
 *
 * Called by app.cafy.careers and resume.cafy.careers. `ga` comes from the GA cookies the
 * marketing site set on .cafy.careers; it is saved on the user so the Stripe webhook can
 * send purchase events for the same visitor later. See analytics/ga4.ts.
 */
export async function handleAnalyticsEvent(req: Request, res: Response): Promise<void> {
    const uid = (req as Request & { user?: { uid?: string } }).user?.uid;
    if (!uid) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    const { event, method, activationType } = (req.body ?? {}) as {
        event?: unknown;
        method?: unknown;
        activationType?: unknown;
    };
    const link = parseGaLink((req.body ?? {}).ga);
    if (!link) {
        // No GA cookie means no analytics consent on the website: nothing to record.
        res.status(204).end();
        return;
    }

    await saveGaLink(uid, link);

    if (event === 'sign_up' && typeof method === 'string' && SIGN_UP_METHODS.has(method)) {
        try {
            const created = Date.parse((await admin.auth().getUser(uid)).metadata.creationTime);
            if (Date.now() - created <= SIGN_UP_MAX_AGE_MS) {
                await sendGaEvent(uid, 'sign_up', { method }, { link, onceKey: 'sign_up' });
            }
        } catch (err) {
            console.warn('[ga4] sign_up check failed:', err);
        }
    } else if (event === 'activation' && typeof activationType === 'string' && ACTIVATION_TYPES.has(activationType)) {
        await sendGaEvent(uid, 'activation', { activation_type: activationType }, { link, onceKey: 'activation' });
    }

    res.status(204).end();
}
