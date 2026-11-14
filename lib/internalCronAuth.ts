import type { Request } from 'express';

/**
 * Authorize internal cron/maintenance routes.
 * - With CRON_SECRET: requires Authorization: Bearer <secret> (Vercel adds this on cron when set).
 * - Without CRON_SECRET: accepts Vercel Cron requests (x-vercel-cron: 1).
 */
export function isAuthorizedInternalCron(req: Request): boolean {
    const secret = process.env.CRON_SECRET?.trim();
    if (secret) {
        return req.headers.authorization === `Bearer ${secret}`;
    }

    return req.headers['x-vercel-cron'] === '1';
}
