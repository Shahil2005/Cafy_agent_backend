import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import type { AutofillProfile } from '../ai/schemas/autofill';

// Keyed by a hash of the resume text: the same resume always maps to the same doc, so a
// re-parse is never needed and the user's own corrections survive across sessions.
const PROFILE_DOC = (uid: string, profileId: string) => `users/${uid}/autofillProfiles/${profileId}`;

export interface StoredAutofillProfile {
    profile: AutofillProfile;
    /** 'ai' = straight from the model; 'user' = corrected by the user in the extension. */
    source: 'ai' | 'user';
    model?: string | null;
    createdAt?: admin.firestore.Timestamp;
    updatedAt?: admin.firestore.Timestamp;
}

/** Whitespace-insensitive, so re-extracting the same PDF doesn't miss the cache. */
export function computeResumeTextHash(resumeText: string): string {
    const normalized = resumeText.replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized).digest('hex');
}

export async function getStoredAutofillProfile(uid: string, profileId: string): Promise<StoredAutofillProfile | null> {
    const snap = await admin.firestore().doc(PROFILE_DOC(uid, profileId)).get();
    return snap.exists ? (snap.data() as StoredAutofillProfile) : null;
}

export async function saveAutofillProfile(
    uid: string,
    profileId: string,
    profile: AutofillProfile,
    source: StoredAutofillProfile['source'],
    model?: string
): Promise<void> {
    const ref = admin.firestore().doc(PROFILE_DOC(uid, profileId));
    const now = admin.firestore.FieldValue.serverTimestamp();
    await admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const existing = snap.exists ? (snap.data() as StoredAutofillProfile) : null;
        // Full overwrite (not merge) so keys dropped from the profile don't linger in Firestore.
        tx.set(ref, {
            profile,
            source,
            model: model ?? existing?.model ?? null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        });
    });
}
