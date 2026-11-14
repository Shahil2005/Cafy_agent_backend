import * as admin from 'firebase-admin';
import { isFullPremiumActive, refreshSubscriptionIfExpired } from '../billing/subscriptionService';
import {
    getFreeCommHistoryLimit,
    getPremiumCommHistoryCap,
    isCommHistoryEnabled,
} from './config';
import type {
    CommunicationDocumentType,
    CommunicationInputParams,
    CommunicationJobSnapshot,
    CommunicationRecord,
    CommunicationSource,
    SaveCommunicationMeta,
} from './schema';

const SPLIT_MARKER = '@@SPLIT@@';
const PREVIEW_LENGTH = 150;
const MAX_CONTENT_LENGTH = 50_000;
const MAX_JD_LENGTH = 20_000;

export interface SaveCommunicationParams {
    userId: string;
    documentType: CommunicationDocumentType;
    source: CommunicationSource;
    rawText: string;
    job: CommunicationJobSnapshot;
    inputParams: CommunicationInputParams;
    meta?: SaveCommunicationMeta;
}

export interface SaveCommunicationResult {
    commId: string;
    threadId: string;
    version: number;
}

function communicationsCollection(userId: string) {
    return admin.firestore().collection(`users/${userId}/communications`);
}

function isFirestoreSentinel(value: unknown): boolean {
    return (
        value instanceof admin.firestore.FieldValue ||
        value instanceof admin.firestore.Timestamp
    );
}

/** Firestore rejects `undefined` — strip it from nested objects before writes. */
function stripUndefinedDeep(value: unknown): unknown {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object' || isFirestoreSentinel(value)) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(stripUndefinedDeep);
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const cleaned = stripUndefinedDeep(val);
        if (cleaned !== undefined) {
            result[key] = cleaned;
        }
    }
    return result;
}

function splitContent(raw: string): { content: string; strategyContent?: string } {
    if (raw.includes(SPLIT_MARKER)) {
        const [content, ...rest] = raw.split(SPLIT_MARKER);
        return {
            content: content.trim(),
            strategyContent: rest.join(SPLIT_MARKER).trim() || undefined,
        };
    }
    return { content: raw.trim() };
}

function buildTitle(documentType: CommunicationDocumentType, company: string): string {
    const label = documentType === 'coverletter' ? 'Cover Letter' : 'Email';
    return company ? `${label} — ${company}` : label;
}

function buildThreadId(jobId: string | null | undefined, documentType: CommunicationDocumentType): string | null {
    if (!jobId) return null;
    return `${jobId}_${documentType}`;
}

function toIsoString(value: unknown): string {
    if (value instanceof admin.firestore.Timestamp) {
        return value.toDate().toISOString();
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return new Date().toISOString();
}

function mapDocToRecord(id: string, data: FirebaseFirestore.DocumentData): CommunicationRecord {
    return {
        id,
        threadId: data.threadId,
        version: data.version ?? 1,
        isLatest: data.isLatest ?? true,
        documentType: data.documentType,
        source: data.source,
        jobId: data.jobId ?? null,
        jobSnapshot: data.jobSnapshot,
        inputParams: data.inputParams,
        resumeId: data.resumeId ?? null,
        content: data.content,
        strategyContent: data.strategyContent,
        userEdited: data.userEdited ?? false,
        title: data.title,
        preview: data.preview,
        createdAt: toIsoString(data.createdAt),
        updatedAt: toIsoString(data.updatedAt),
    };
}

function isFailedPrecondition(err: unknown): boolean {
    const code =
        err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: unknown }).code)
            : '';
    const message = err instanceof Error ? err.message : String(err ?? '');
    return (
        code === 'failed-precondition' ||
        message.includes('FAILED_PRECONDITION') ||
        message.includes('requires an index')
    );
}

async function enforceRetentionLimit(userId: string): Promise<void> {
    const subscription = await refreshSubscriptionIfExpired(userId);
    const premium = isFullPremiumActive(subscription);
    const limit = premium ? getPremiumCommHistoryCap() : getFreeCommHistoryLimit();

    const collectionRef = communicationsCollection(userId);
    // Only need to know whether we are over the cap and which oldest docs to soft-delete.
    // Cap the query so retention never loads the user's entire history.
    const fetchLimit = limit + 50;
    const snap = await collectionRef.orderBy('createdAt', 'asc').limit(fetchLimit).get();
    const activeDocs = snap.docs.filter((doc) => doc.data().isDeleted !== true);

    if (activeDocs.length <= limit) return;

    // If the capped page is entirely active and still over limit, delete the overflow in this page.
    // Remaining overflow (if history >> fetchLimit) is trimmed on subsequent saves.
    const toRemove = activeDocs.slice(0, activeDocs.length - limit);
    const batch = admin.firestore().batch();
    const now = admin.firestore.FieldValue.serverTimestamp();

    for (const doc of toRemove) {
        batch.update(doc.ref, { isDeleted: true, deletedAt: now, updatedAt: now });
    }

    await batch.commit();
}

async function findLatestThreadDocs(
    collectionRef: FirebaseFirestore.CollectionReference,
    threadId: string
): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
    try {
        const priorSnap = await collectionRef
            .where('threadId', '==', threadId)
            .where('isLatest', '==', true)
            .limit(5)
            .get();
        return priorSnap.docs.filter((doc) => doc.data().isDeleted !== true);
    } catch (err) {
        if (!isFailedPrecondition(err)) throw err;
        console.warn(
            '[communications] threadId+isLatest index missing; falling back to threadId query'
        );
        const priorSnap = await collectionRef.where('threadId', '==', threadId).get();
        return priorSnap.docs.filter(
            (doc) => doc.data().isLatest === true && doc.data().isDeleted !== true
        );
    }
}

export async function saveCommunication(
    params: SaveCommunicationParams
): Promise<SaveCommunicationResult | null> {
    if (!isCommHistoryEnabled()) return null;

    const collectionRef = communicationsCollection(params.userId);
    const { content, strategyContent } = splitContent(params.rawText);
    const truncatedContent = content.slice(0, MAX_CONTENT_LENGTH);
    const preview = truncatedContent.slice(0, PREVIEW_LENGTH);

    const resolvedThreadId =
        params.meta?.threadId ?? buildThreadId(params.meta?.jobId, params.documentType);

    let version = 1;
    if (resolvedThreadId) {
        const priorLatest = await findLatestThreadDocs(collectionRef, resolvedThreadId);

        if (priorLatest.length > 0) {
            const priorDoc = priorLatest.reduce((latest, doc) => {
                const latestVersion = latest.data().version as number;
                const docVersion = doc.data().version as number;
                return docVersion > latestVersion ? doc : latest;
            });
            version = (priorDoc.data().version as number) + 1;
            await priorDoc.ref.update({
                isLatest: false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const docRef = await collectionRef.add(
        stripUndefinedDeep({
            threadId: resolvedThreadId,
            version,
            isLatest: true,
            documentType: params.documentType,
            source: params.source,
            jobId: params.meta?.jobId ?? null,
            jobSnapshot: {
                role: params.job.role,
                company: params.job.company,
                jobDescription: params.job.jobDescription?.slice(0, MAX_JD_LENGTH),
            },
            inputParams: params.inputParams,
            resumeId: params.meta?.resumeId ?? null,
            content: truncatedContent,
            strategyContent: strategyContent?.slice(0, MAX_CONTENT_LENGTH) ?? null,
            userEdited: false,
            title: buildTitle(params.documentType, params.job.company),
            preview,
            isDeleted: false,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
        }) as FirebaseFirestore.DocumentData
    );

    const threadId = resolvedThreadId ?? docRef.id;
    if (!resolvedThreadId) {
        await docRef.update({ threadId });
    }

    try {
        await enforceRetentionLimit(params.userId);
    } catch (err) {
        console.error('[communications] Retention enforcement failed:', err);
    }

    return { commId: docRef.id, threadId, version };
}

async function listCommunicationsLegacy(
    userId: string,
    options: {
        jobId?: string;
        documentType?: CommunicationDocumentType;
        limit?: number;
        cursor?: string;
    }
): Promise<{ items: CommunicationRecord[]; nextCursor: string | null }> {
    const limit = options.limit ?? 20;
    const collectionRef = communicationsCollection(userId);

    // Paginate server-side until we fill one page of active docs (avoids fixed 200 over-fetch).
    const pageDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    let query: FirebaseFirestore.Query = collectionRef.orderBy('createdAt', 'desc');
    let startAfterSnap: FirebaseFirestore.DocumentSnapshot | null = null;

    if (options.cursor) {
        const [, docId] = options.cursor.split('|');
        if (docId) {
            const cursorSnap = await collectionRef.doc(docId).get();
            if (cursorSnap.exists) {
                startAfterSnap = cursorSnap;
            }
        }
    }

    const maxPages = 5;
    for (let page = 0; page < maxPages && pageDocs.length <= limit; page++) {
        let pageQuery = query.limit(limit);
        if (startAfterSnap) {
            pageQuery = pageQuery.startAfter(startAfterSnap);
        }
        const snap = await pageQuery.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
            const data = doc.data();
            if (data.isDeleted === true) continue;
            if (options.jobId && data.jobId !== options.jobId) continue;
            if (options.documentType && data.documentType !== options.documentType) continue;
            pageDocs.push(doc);
            if (pageDocs.length > limit) break;
        }

        startAfterSnap = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < limit) break;
    }

    const itemsDocs = pageDocs.slice(0, limit);
    const items = itemsDocs.map((doc) => mapDocToRecord(doc.id, doc.data()));

    let nextCursor: string | null = null;
    if (pageDocs.length > limit && itemsDocs.length > 0) {
        const last = itemsDocs[itemsDocs.length - 1];
        const createdAt = toIsoString(last.data().createdAt);
        nextCursor = `${createdAt}|${last.id}`;
    }

    return { items, nextCursor };
}

async function listCommunicationsIndexed(
    userId: string,
    options: {
        jobId?: string;
        documentType?: CommunicationDocumentType;
        limit?: number;
        cursor?: string;
    }
): Promise<{ items: CommunicationRecord[]; nextCursor: string | null }> {
    const limit = options.limit ?? 20;
    const collectionRef = communicationsCollection(userId);

    // Server-side jobId/documentType filters when present (composite indexes).
    // isDeleted is filtered in memory so legacy docs missing the field still appear.
    let query: FirebaseFirestore.Query = collectionRef.orderBy('createdAt', 'desc');

    if (options.jobId) {
        query = query.where('jobId', '==', options.jobId);
    }
    if (options.documentType) {
        query = query.where('documentType', '==', options.documentType);
    }

    let startAfterSnap: FirebaseFirestore.DocumentSnapshot | null = null;
    if (options.cursor) {
        const [, docId] = options.cursor.split('|');
        if (docId) {
            const cursorSnap = await collectionRef.doc(docId).get();
            if (cursorSnap.exists) {
                startAfterSnap = cursorSnap;
            }
        }
    }

    const pageDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    const maxPages = 5;
    for (let page = 0; page < maxPages && pageDocs.length <= limit; page++) {
        let pageQuery = query.limit(Math.max(limit, 20));
        if (startAfterSnap) {
            pageQuery = pageQuery.startAfter(startAfterSnap);
        }
        const snap = await pageQuery.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
            if (doc.data().isDeleted === true) continue;
            pageDocs.push(doc);
            if (pageDocs.length > limit) break;
        }

        startAfterSnap = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < limit) break;
    }

    const itemsDocs = pageDocs.slice(0, limit);
    const items = itemsDocs.map((doc) => mapDocToRecord(doc.id, doc.data()));

    let nextCursor: string | null = null;
    if (pageDocs.length > limit && itemsDocs.length > 0) {
        const last = itemsDocs[itemsDocs.length - 1];
        const createdAt = toIsoString(last.data().createdAt);
        nextCursor = `${createdAt}|${last.id}`;
    }

    return { items, nextCursor };
}

export async function listCommunications(
    userId: string,
    options: {
        jobId?: string;
        documentType?: CommunicationDocumentType;
        limit?: number;
        cursor?: string;
    }
): Promise<{ items: CommunicationRecord[]; nextCursor: string | null }> {
    try {
        return await listCommunicationsIndexed(userId, options);
    } catch (err) {
        if (!isFailedPrecondition(err)) throw err;
        console.warn(
            '[communications] composite list index missing; using bounded legacy pagination'
        );
        return listCommunicationsLegacy(userId, options);
    }
}

export async function getCommunication(
    userId: string,
    commId: string
): Promise<CommunicationRecord | null> {
    const doc = await communicationsCollection(userId).doc(commId).get();
    if (!doc.exists) return null;

    const data = doc.data()!;
    if (data.isDeleted) return null;

    return mapDocToRecord(doc.id, data);
}

export async function deleteCommunication(userId: string, commId: string): Promise<boolean> {
    const docRef = communicationsCollection(userId).doc(commId);
    const doc = await docRef.get();
    if (!doc.exists || doc.data()?.isDeleted) return false;

    await docRef.update({
        isDeleted: true,
        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return true;
}

export function extractGeminiText(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const candidates = (body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
        .candidates;
    const text = candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === 'string' ? text : null;
}
