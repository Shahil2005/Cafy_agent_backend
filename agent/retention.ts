import * as admin from 'firebase-admin';

/**
 * Daily retention: physically deletes the agent's OWN documents once they pass `expiresAt`
 * (chats 30 days, CV analyses 90 days, feedback 365 days). Expired documents are already hidden
 * from users; this removes them, as the privacy notice promises.
 *
 * Only these three collection names are queried, and every document's path is checked to be
 * exactly users/{uid}/<agent collection>/{id} before it is deleted. No other data is touched.
 *
 * The collection-group queries need a single-field index exemption on `expiresAt` for each
 * collection group (see CAFY_CHAT_AGENT_PLAN.md, "B5 rollout"); until then the job reports
 * the missing index and deletes nothing.
 */
export const AGENT_COLLECTIONS = ['agentConversations', 'agentCvProfiles', 'agentFeedback'] as const;
type AgentCollection = (typeof AGENT_COLLECTIONS)[number];

const PAGE_SIZE = 200;

export interface ExpiredDoc {
    path: string;
}

export interface RetentionStore {
    /** Up to `limit` documents of the collection group whose expiresAt is before `now`. */
    expired(collection: AgentCollection, now: number, limit: number): Promise<ExpiredDoc[]>;
    delete(paths: string[]): Promise<void>;
}

/** users/{uid}/{collection}/{id} and nothing else. */
export function isAgentDocPath(path: string, collection: AgentCollection): boolean {
    const parts = path.split('/');
    return parts.length === 4 && parts[0] === 'users' && parts[1]!.length > 0 && parts[2] === collection && parts[3]!.length > 0;
}

export const firestoreRetentionStore: RetentionStore = {
    async expired(collection, now, limit) {
        const snap = await admin.firestore().collectionGroup(collection).where('expiresAt', '<', now).limit(limit).select().get();
        return snap.docs.map((doc) => ({ path: doc.ref.path }));
    },
    async delete(paths) {
        const db = admin.firestore();
        const batch = db.batch();
        for (const path of paths) batch.delete(db.doc(path));
        await batch.commit();
    },
};

export interface RetentionResult {
    deleted: Record<AgentCollection, number>;
    skippedPaths: number;
    complete: boolean;
    errors: string[];
}

export async function runAgentRetention(
    store: RetentionStore = firestoreRetentionStore,
    { now = Date.now(), budgetMs = 40_000 }: { now?: number; budgetMs?: number } = {},
): Promise<RetentionResult> {
    const startedAt = Date.now();
    const result: RetentionResult = { deleted: { agentConversations: 0, agentCvProfiles: 0, agentFeedback: 0 }, skippedPaths: 0, complete: true, errors: [] };
    for (const collection of AGENT_COLLECTIONS) {
        try {
            for (;;) {
                if (Date.now() - startedAt > budgetMs) {
                    result.complete = false;
                    return result;
                }
                const page = await store.expired(collection, now, PAGE_SIZE);
                const paths = page.map((d) => d.path).filter((path) => isAgentDocPath(path, collection));
                result.skippedPaths += page.length - paths.length;
                if (paths.length) {
                    await store.delete(paths);
                    result.deleted[collection] += paths.length;
                }
                // A short page means nothing else has expired; a page of only skipped paths would loop forever.
                if (page.length < PAGE_SIZE || !paths.length) break;
            }
        } catch (error) {
            // Error code only (e.g. FAILED_PRECONDITION when the index exemption is missing).
            const code = (error as { code?: unknown })?.code;
            result.errors.push(`${collection}:${typeof code === 'string' || typeof code === 'number' ? code : 'error'}`);
            result.complete = false;
        }
    }
    return result;
}
