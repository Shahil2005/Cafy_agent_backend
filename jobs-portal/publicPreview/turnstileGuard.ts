/**
 * Requires a fresh Cloudflare Turnstile token (header `X-Turnstile-Token`) on every
 * public preview request. Tokens are single-use and expire after 5 minutes, so
 * scripts without a real browser challenge get 401. Reuses TURNSTILE_SECRET_KEY.
 */
import type { NextFunction, Request, Response } from 'express';
import { isTurnstileVerified, verifyTurnstileToken } from '../../turnstileService';

const TURNSTILE_VERIFY_TIMEOUT_MS = 5000;
const MAX_TOKEN_LENGTH = 2048;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Turnstile verification timed out')), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

export async function requireTurnstileToken(req: Request, res: Response, next: NextFunction) {
    const token = req.get('X-Turnstile-Token')?.trim();
    if (!token || token.length > MAX_TOKEN_LENGTH) {
        return res.status(401).json({ error: 'Verification required', code: 'VERIFICATION_REQUIRED' });
    }

    let verified: boolean;
    try {
        const result = await withTimeout(verifyTurnstileToken(token, req.ip), TURNSTILE_VERIFY_TIMEOUT_MS);
        verified = isTurnstileVerified(result);
    } catch (error) {
        // Cloudflare unreachable / misconfigured — fail closed, but as 503 so the client retries.
        console.error('[public-preview] turnstile verification unavailable:', error);
        return res.status(503).json({ error: 'Verification temporarily unavailable', code: 'VERIFICATION_UNAVAILABLE' });
    }

    if (!verified) {
        return res.status(401).json({ error: 'Verification failed', code: 'VERIFICATION_REQUIRED' });
    }
    return next();
}
