/**
 * Migrate Firestore preferences.experienceLevel → 4-level taxonomy.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/migrateExperienceLevelsTo4.ts
 *   npx ts-node --transpile-only scripts/migrateExperienceLevelsTo4.ts --apply
 */
import '../env';
import * as admin from 'firebase-admin';
import { sanitizeUserExperienceLevels } from '../jobs-portal/levelMapping';

const APPLY = process.argv.includes('--apply');
const PAGE = 400;

function initAdmin() {
    if (admin.apps.length) return;
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
    });
}

function sameLevels(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

async function main() {
    initAdmin();
    const db = admin.firestore();

    let scanned = 0;
    let withLevels = 0;
    let needsChange = 0;
    let updated = 0;
    let droppedUnknown = 0;
    const samples: Array<{ uid: string; before: string[]; after: string[] }> = [];
    const unknownCounts: Record<string, number> = {};

    let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
        let q = db
            .collection('users')
            .orderBy(admin.firestore.FieldPath.documentId())
            .limit(PAGE);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;

        const batch = db.batch();
        let batchOps = 0;

        for (const doc of snap.docs) {
            scanned += 1;
            const data = doc.data() || {};
            const prefs = (data.preferences || {}) as { experienceLevel?: unknown };
            const raw = prefs.experienceLevel;
            if (!Array.isArray(raw) || raw.length === 0) continue;

            withLevels += 1;
            const before = raw.map((v) => String(v));
            const after = sanitizeUserExperienceLevels(before);

            for (const v of before) {
                const trimmed = String(v).trim();
                if (!trimmed) continue;
                const mapped = sanitizeUserExperienceLevels([trimmed]);
                if (!mapped.length) {
                    unknownCounts[trimmed] = (unknownCounts[trimmed] || 0) + 1;
                    droppedUnknown += 1;
                }
            }

            if (sameLevels(before, after)) continue;
            needsChange += 1;

            if (samples.length < 15) {
                samples.push({ uid: doc.id, before, after });
            }

            if (APPLY) {
                batch.set(
                    doc.ref,
                    {
                        preferences: {
                            ...prefs,
                            experienceLevel: after,
                            updatedAt: new Date().toISOString(),
                        },
                    },
                    { merge: true }
                );
                batchOps += 1;
                updated += 1;
            }
        }

        if (APPLY && batchOps > 0) {
            await batch.commit();
        }

        last = snap.docs[snap.docs.length - 1];
        if (scanned % 2000 === 0) {
            console.error(`scanned=${scanned} withLevels=${withLevels} needsChange=${needsChange}`);
        }
    }

    console.log(
        JSON.stringify(
            {
                mode: APPLY ? 'apply' : 'dry-run',
                scanned,
                withLevels,
                needsChange,
                updated,
                droppedUnknown,
                unknownCounts,
                samples,
            },
            null,
            2
        )
    );

    if (!APPLY) {
        console.error('Dry-run only. Re-run with --apply to write.');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
