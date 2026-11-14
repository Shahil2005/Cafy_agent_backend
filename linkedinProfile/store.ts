import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import type { LinkedinOptimizerInput } from '../ai/schemas/linkedinOptimizer';

const PROFILE_DOC = (uid: string) => `users/${uid}/linkedinOptimizer/profile`;

export interface StoredLinkedinProfile {
    scrapedData?: LinkedinOptimizerInput;
    scrapedHash?: string;
    lastScrapedAt?: admin.firestore.Timestamp;
    optimizationHash?: string | null;
    optimizationText?: string | null;
    lastOptimizedAt?: admin.firestore.Timestamp | null;
}

function getFirestoreDb(): admin.firestore.Firestore {
    return admin.firestore();
}

/** Stable hash of the AI input fields — key order doesn't affect the result. */
export function computeInputHash(input: LinkedinOptimizerInput): string {
    const ordered = {
        headline: input.headline,
        about: input.about,
        experience: input.experience,
        education: input.education,
        skills: input.skills,
        certifications: input.certifications,
        projects: input.projects,
        targetRole: input.targetRole,
        resumeText: input.resumeText,
    };
    return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export async function getStoredLinkedinProfile(uid: string): Promise<StoredLinkedinProfile | null> {
    const snap = await getFirestoreDb().doc(PROFILE_DOC(uid)).get();
    return snap.exists ? (snap.data() as StoredLinkedinProfile) : null;
}

/** Persists the latest scrape. Always called on scan, regardless of cache hit/miss. */
export async function saveScrapedProfile(
    uid: string,
    input: LinkedinOptimizerInput,
    hash: string
): Promise<void> {
    await getFirestoreDb().doc(PROFILE_DOC(uid)).set(
        {
            scrapedData: input,
            scrapedHash: hash,
            lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
}

/** Persists a freshly-generated AI optimisation, keyed by the input hash that produced it. */
export async function saveOptimizationResult(uid: string, hash: string, text: string): Promise<void> {
    await getFirestoreDb().doc(PROFILE_DOC(uid)).set(
        {
            optimizationHash: hash,
            optimizationText: text,
            lastOptimizedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
    );
}
