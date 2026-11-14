import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

const COLLECTION = 'deleted_users';

/** Days the same email cannot create a new account after deletion. */
export const DELETED_EMAIL_BLOCK_DAYS = 10;

export function normalizeAccountEmail(email: string): string {
    return String(email || '')
        .trim()
        .toLowerCase();
}

/** Firestore doc id from email — avoids reserved characters in emails. */
export function deletedUserDocId(email: string): string {
    const normalized = normalizeAccountEmail(email);
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

export type DeletedUserTombstone = {
    /** Email this doc blocks (Auth or Stripe checkout). */
    email: string;
    /** Firebase Auth email at deletion (may differ from Stripe). */
    authEmail?: string;
    /** Stripe Customer / Checkout email at deletion (may differ from Auth). */
    stripeCheckoutEmail?: string | null;
    deletedAt?: admin.firestore.Timestamp;
    blockedUntil?: admin.firestore.Timestamp;
    previousUid?: string;
    blockDays?: number;
};

export async function getDeletedUserTombstone(email: string): Promise<DeletedUserTombstone | null> {
    const normalized = normalizeAccountEmail(email);
    if (!normalized) return null;
    const snap = await admin.firestore().collection(COLLECTION).doc(deletedUserDocId(normalized)).get();
    if (!snap.exists) return null;
    return snap.data() as DeletedUserTombstone;
}

function tombstoneBlockEndMs(row: DeletedUserTombstone): number | null {
    if (row.blockedUntil && typeof row.blockedUntil.toMillis === 'function') {
        return row.blockedUntil.toMillis();
    }
    if (row.deletedAt && typeof row.deletedAt.toMillis === 'function') {
        const days = typeof row.blockDays === 'number' && row.blockDays > 0
            ? row.blockDays
            : DELETED_EMAIL_BLOCK_DAYS;
        return row.deletedAt.toMillis() + days * 24 * 60 * 60 * 1000;
    }
    return null;
}

/** True only while the post-delete re-signup block is still active. */
export async function isEmailTombstoned(email: string): Promise<boolean> {
    const row = await getDeletedUserTombstone(email);
    if (!row) return false;
    const endMs = tombstoneBlockEndMs(row);
    if (endMs == null) return true;
    return Date.now() < endMs;
}

/**
 * Write one tombstone doc per unique email so Auth and Stripe checkout addresses
 * both fail assert-signup-allowed for DELETED_EMAIL_BLOCK_DAYS.
 */
export async function writeDeletedUserTombstone(params: {
    email: string;
    previousUid: string;
    stripeCheckoutEmail?: string | null;
}): Promise<void> {
    const authEmail = normalizeAccountEmail(params.email);
    if (!authEmail) {
        throw new Error('MISSING_EMAIL');
    }
    const stripeCheckoutEmail = normalizeAccountEmail(params.stripeCheckoutEmail || '');
    const emails = Array.from(
        new Set([authEmail, stripeCheckoutEmail].filter(Boolean))
    );

    const now = admin.firestore.Timestamp.now();
    const blockedUntil = admin.firestore.Timestamp.fromMillis(
        now.toMillis() + DELETED_EMAIL_BLOCK_DAYS * 24 * 60 * 60 * 1000
    );

    const db = admin.firestore();
    const batch = db.batch();
    for (const blockedEmail of emails) {
        const ref = db.collection(COLLECTION).doc(deletedUserDocId(blockedEmail));
        batch.set(
            ref,
            {
                email: blockedEmail,
                authEmail,
                stripeCheckoutEmail: stripeCheckoutEmail || null,
                previousUid: params.previousUid,
                deletedAt: admin.firestore.FieldValue.serverTimestamp(),
                blockedUntil,
                blockDays: DELETED_EMAIL_BLOCK_DAYS,
            },
            { merge: true }
        );
    }
    await batch.commit();
}
