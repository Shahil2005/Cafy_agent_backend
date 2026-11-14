import crypto from 'crypto';
import * as admin from 'firebase-admin';
import type { EmailCampaign } from './config';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface EmailOutboxDoc {
    campaign: EmailCampaign;
    uid: string;
    to: string;
    payload: Record<string, string | number>;
    status: OutboxStatus;
    idempotencyKey: string;
    attempts: number;
    lastError?: string | null;
    providerMessageId?: string | null;
    sendAfter?: admin.firestore.Timestamp | null;
    createdAt: admin.firestore.FieldValue | admin.firestore.Timestamp;
    updatedAt: admin.firestore.FieldValue | admin.firestore.Timestamp;
    lockedAt?: admin.firestore.Timestamp | null;
}

export function outboxIdForKey(idempotencyKey: string): string {
    return crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40);
}

function outboxCollection() {
    return admin.firestore().collection('emailOutbox');
}

export interface EnqueueEmailParams {
    campaign: EmailCampaign;
    uid: string;
    to: string;
    payload: Record<string, string | number>;
    idempotencyKey: string;
    sendAfterMs?: number;
}

export async function enqueueEmail(params: EnqueueEmailParams): Promise<{ id: string; created: boolean }> {
    const id = outboxIdForKey(params.idempotencyKey);
    const ref = outboxCollection().doc(id);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const sendAfter = admin.firestore.Timestamp.fromMillis(params.sendAfterMs ?? Date.now());

    try {
        await ref.create({
            campaign: params.campaign,
            uid: params.uid,
            to: params.to,
            payload: params.payload,
            status: 'pending',
            idempotencyKey: params.idempotencyKey,
            attempts: 0,
            lastError: null,
            providerMessageId: null,
            sendAfter,
            createdAt: now,
            updatedAt: now,
            lockedAt: null,
        });
        return { id, created: true };
    } catch (err: unknown) {
        const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
        if (code === '6' || code === 'already-exists') {
            return { id, created: false };
        }
        throw err;
    }
}

const STALE_LOCK_MS = 10 * 60 * 1000;
const BATCH_SIZE = 20;

export async function claimPendingOutbox(
    limit = BATCH_SIZE
): Promise<Array<{ id: string; data: FirebaseFirestore.DocumentData }>> {
    const db = admin.firestore();
    let pendingDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    try {
        const pending = await outboxCollection()
            .where('status', '==', 'pending')
            .orderBy('createdAt', 'asc')
            .limit(Math.max(limit * 5, 50))
            .get();
        pendingDocs = pending.docs;
    } catch {
        const pending = await outboxCollection()
            .where('status', '==', 'pending')
            .limit(Math.max(limit * 5, 50))
            .get();
        pendingDocs = pending.docs;
    }

    const sending = await outboxCollection().where('status', '==', 'sending').limit(limit).get();
    const snap = { docs: [...pendingDocs, ...sending.docs] };

    const claimed: Array<{ id: string; data: FirebaseFirestore.DocumentData }> = [];
    const now = Date.now();

    for (const doc of snap.docs) {
        if (claimed.length >= limit) break;
        const data = doc.data();
        const sendAfter = data.sendAfter as admin.firestore.Timestamp | null | undefined;
        if (sendAfter && sendAfter.toMillis() > now) {
            continue;
        }
        const lockedAt = data.lockedAt as admin.firestore.Timestamp | null | undefined;
        if (data.status === 'sending' && lockedAt && now - lockedAt.toMillis() < STALE_LOCK_MS) {
            continue;
        }

        const ok = await db.runTransaction(async (tx) => {
            const fresh = await tx.get(doc.ref);
            if (!fresh.exists) return false;
            const current = fresh.data()!;
            if (current.status === 'sent' || current.status === 'skipped' || current.status === 'failed') {
                return false;
            }
            if (current.status === 'sending') {
                const lock = current.lockedAt as admin.firestore.Timestamp | null | undefined;
                if (lock && Date.now() - lock.toMillis() < STALE_LOCK_MS) return false;
            }
            tx.update(doc.ref, {
                status: 'sending',
                lockedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return true;
        });

        if (ok) claimed.push({ id: doc.id, data });
    }

    return claimed;
}

export async function markOutboxSent(id: string, providerMessageId: string | null): Promise<void> {
    await outboxCollection().doc(id).update({
        status: 'sent',
        providerMessageId,
        lastError: null,
        lockedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

export async function markOutboxSkipped(id: string, reason: string): Promise<void> {
    await outboxCollection().doc(id).update({
        status: 'skipped',
        lastError: reason,
        lockedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

export async function markOutboxFailed(id: string, error: string, attempts: number): Promise<void> {
    const terminal = attempts >= 5;
    await outboxCollection().doc(id).update({
        status: terminal ? 'failed' : 'pending',
        attempts,
        lastError: error,
        lockedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}
