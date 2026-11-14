import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { captureServerError } from '../lib/observability/sentry';
import { verifyCalComWebhookSignature } from './calcomWebhookVerify';
import { processCalComWebhook } from './webhookService';
import { getCalComWebhookSecret } from './config';

export function createCalComWebhookHandler(resumeSupabase: SupabaseClient) {
    return async function handleCalComWebhook(req: Request, res: Response): Promise<void> {
        const rawBody = req.body as Buffer;
        if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
            res.status(400).send('Empty body');
            return;
        }

        const signature = req.headers['x-cal-signature-256'] as string | undefined;

        if (process.env.NODE_ENV === 'production' && !getCalComWebhookSecret()) {
            console.error('[counselling webhook] CALCOM_WEBHOOK_SECRET missing in production');
            res.status(503).send('Webhook not configured');
            return;
        }

        if (!verifyCalComWebhookSignature(rawBody, signature)) {
            console.warn('[counselling webhook] invalid signature');
            res.status(401).send('Invalid signature');
            return;
        }

        if (!getCalComWebhookSecret() && process.env.NODE_ENV !== 'production') {
            console.warn(
                '[counselling webhook] CALCOM_WEBHOOK_SECRET not set — accepting unsigned (local dev only)'
            );
        }

        let body: unknown;
        try {
            body = JSON.parse(rawBody.toString('utf8'));
        } catch {
            res.status(400).send('Invalid JSON');
            return;
        }

        const trigger = (body as { triggerEvent?: string }).triggerEvent;
        if (trigger === 'PING') {
            res.status(200).json({ ok: true });
            return;
        }

        try {
            await processCalComWebhook(resumeSupabase, body as Parameters<typeof processCalComWebhook>[1]);
            res.status(200).json({ ok: true });
        } catch (err) {
            console.error('[counselling webhook] handler error:', err);
            captureServerError(err, { tags: { feature: 'counselling', route: 'calcom-webhook' } });
            res.status(500).send('Webhook processing failed');
        }
    };
}
