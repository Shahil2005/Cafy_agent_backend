import { Router, Request, Response } from 'express';
import {
    ACCOUNT_DELETE_CONFIRM_PHRASE,
    deleteUserAccount,
} from './deleteService';
import {
    DELETED_EMAIL_BLOCK_DAYS,
    isEmailTombstoned,
    normalizeAccountEmail,
} from './tombstone';
import { captureServerError } from '../lib/observability/sentry';

type VerifyToken = (req: Request, res: Response, next: () => void) => Promise<void | Response>;

export function createAccountRouter(verifyToken: VerifyToken): Router {
    const router = Router();

    /**
     * After Auth signup (email or Google), call with the new user's ID token.
     * If email is tombstoned, Auth user is deleted and signup is rejected.
     */
    router.post('/assert-signup-allowed', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as any).user?.uid as string | undefined;
            const email = normalizeAccountEmail((req as any).user?.email || '');
            if (!uid || !email) {
                return res.status(400).json({ error: 'MISSING_IDENTITY' });
            }
            if (await isEmailTombstoned(email)) {
                try {
                    const admin = await import('firebase-admin');
                    await admin.auth().deleteUser(uid);
                } catch (err) {
                    console.warn('[account] failed to remove tombstoned signup:', err);
                }
                return res.status(403).json({
                    error: 'EMAIL_DELETED',
                    message: `This email was used for a recently deleted Cafy account. You can create a new account with it after ${DELETED_EMAIL_BLOCK_DAYS} days. Contact admin@cafy.careers if you need help sooner.`,
                    blockDays: DELETED_EMAIL_BLOCK_DAYS,
                });
            }
            return res.status(200).json({ ok: true });
        } catch (error) {
            console.error('[account] assert-signup-allowed error:', error);
            captureServerError(error, { tags: { route: 'account-assert-signup' } });
            return res.status(500).json({ error: 'ASSERT_FAILED' });
        }
    });

    router.post('/delete', verifyToken, async (req: Request, res: Response) => {
        try {
            const uid = (req as any).user?.uid as string | undefined;
            const email = normalizeAccountEmail((req as any).user?.email || '');
            const confirmationPhrase = String(req.body?.confirmationPhrase || '');

            if (!uid || !email) {
                return res.status(400).json({ error: 'MISSING_IDENTITY' });
            }
            if (confirmationPhrase !== ACCOUNT_DELETE_CONFIRM_PHRASE) {
                return res.status(400).json({
                    error: 'CONFIRMATION_MISMATCH',
                    expectedPhrase: ACCOUNT_DELETE_CONFIRM_PHRASE,
                });
            }

            const result = await deleteUserAccount({
                uid,
                email,
                confirmationPhrase,
            });

            return res.status(200).json({
                success: true,
                email: result.email,
                stripeCancelMode: result.stripeCancelMode,
                storageFilesRemoved: result.storageFilesRemoved,
                message: `Your account data has been removed. Your email is blocked from new signups for ${DELETED_EMAIL_BLOCK_DAYS} days. Stripe payment records may be kept for tax and disputes.`,
                emailBlockDays: DELETED_EMAIL_BLOCK_DAYS,
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[account] delete error:', message, error);
            captureServerError(error, { tags: { route: 'account-delete' } });

            if (message === 'CONFIRMATION_MISMATCH') {
                return res.status(400).json({ error: 'CONFIRMATION_MISMATCH' });
            }
            if (message === 'LEGAL_HOLD') {
                return res.status(403).json({
                    error: 'LEGAL_HOLD',
                    message:
                        'This account cannot be deleted while a billing or legal hold is active. Contact admin@cafy.careers.',
                });
            }
            if (message === 'MISSING_EMAIL') {
                return res.status(400).json({ error: 'MISSING_EMAIL' });
            }
            if (message === 'STRIPE_CANCEL_FAILED') {
                return res.status(502).json({
                    error: 'STRIPE_CANCEL_FAILED',
                    message:
                        'We could not cancel your subscription right now, so your account was not deleted. Please try again in a few minutes or contact admin@cafy.careers.',
                });
            }
            if (message === 'FIRESTORE_WIPE_FAILED' || message === 'AUTH_DELETE_FAILED') {
                return res.status(500).json({
                    error: message,
                    message:
                        'Account deletion did not finish completely. Contact admin@cafy.careers with your account email.',
                });
            }
            return res.status(500).json({ error: 'DELETE_FAILED' });
        }
    });

    return router;
}
