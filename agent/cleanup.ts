import type { Request, Response } from 'express';
import * as admin from 'firebase-admin';
import type { AgentBlock } from './contract';

/**
 * Removes the agent's OWN copies of CVs the user has deleted from their profile.
 *
 * Reads (never writes) the user's resume list at users/{uid}/resumes and the profile CV field.
 * Writes only inside the agent's own folders: deletes users/{uid}/agentCvProfiles docs whose
 * source resumes are all gone, and unlinks those CVs from users/{uid}/agentConversations.
 * The resume records and their storage files are never touched.
 */

export interface CleanupStore {
    /** Ids of the user's current saved resumes, plus 'profile' when a profile CV exists. Read-only. */
    activeResumeIds(uid: string): Promise<Set<string>>;
    /** Current resume names, used only for agent copies made before ids were recorded. */
    activeResumeNames(uid: string): Promise<Set<string>>;
    listAgentCvs(uid: string): Promise<Array<{ hash: string; name?: string; sourceCvIds?: string[] }>>;
    deleteAgentCv(uid: string, hash: string): Promise<void>;
    setAgentCvSources(uid: string, hash: string, ids: string[]): Promise<void>;
    conversationsUsingCvs(uid: string, hashes: string[]): Promise<Array<{ id: string; messages: Array<{ blocks?: AgentBlock[] } & Record<string, unknown>> }>>;
    unlinkConversationCv(uid: string, id: string, messages: unknown[]): Promise<void>;
}

const userDoc = (uid: string) => admin.firestore().collection('users').doc(uid);

export const firestoreCleanupStore: CleanupStore = {
    async activeResumeIds(uid) {
        const [resumes, user] = await Promise.all([userDoc(uid).collection('resumes').select().get(), userDoc(uid).get()]);
        const ids = new Set(resumes.docs.map((d) => d.id));
        if ((user.data()?.resume as { content?: unknown } | undefined)?.content) ids.add('profile');
        return ids;
    },
    async activeResumeNames(uid) {
        const [resumes, user] = await Promise.all([userDoc(uid).collection('resumes').select('name').get(), userDoc(uid).get()]);
        const names = new Set(resumes.docs.map((d) => String(d.data().name ?? '')).filter(Boolean));
        const profileName = (user.data()?.resume as { name?: unknown } | undefined)?.name;
        if (typeof profileName === 'string' && profileName) names.add(profileName);
        return names;
    },
    async listAgentCvs(uid) {
        const snap = await userDoc(uid).collection('agentCvProfiles').select('name', 'sourceCvIds').get();
        return snap.docs.map((d) => ({ hash: d.id, ...(d.data() as { name?: string; sourceCvIds?: string[] }) }));
    },
    async deleteAgentCv(uid, hash) {
        await userDoc(uid).collection('agentCvProfiles').doc(hash).delete();
    },
    async setAgentCvSources(uid, hash, ids) {
        await userDoc(uid).collection('agentCvProfiles').doc(hash).update({ sourceCvIds: ids });
    },
    async conversationsUsingCvs(uid, hashes) {
        const out: Array<{ id: string; messages: Array<{ blocks?: AgentBlock[] } & Record<string, unknown>> }> = [];
        for (let i = 0; i < hashes.length; i += 30) {
            const snap = await userDoc(uid).collection('agentConversations').where('cvHash', 'in', hashes.slice(i, i + 30)).get();
            for (const d of snap.docs) out.push({ id: d.id, messages: (d.data().messages ?? []) as never });
        }
        return out;
    },
    async unlinkConversationCv(uid, id, messages) {
        await userDoc(uid)
            .collection('agentConversations')
            .doc(id)
            .update({ cvHash: admin.firestore.FieldValue.delete(), cvName: admin.firestore.FieldValue.delete(), messages });
    },
};

/** Keeps the chat text; removes only the stored CV cards that came from the deleted CV. */
export function stripCvCards<T extends { blocks?: AgentBlock[] }>(messages: T[]): T[] {
    return messages.map((m) => (m.blocks?.some((b) => b.kind === 'cvProfile') ? { ...m, blocks: m.blocks.filter((b) => b.kind !== 'cvProfile') } : m));
}

export async function cleanupDeletedCvs(uid: string, store: CleanupStore = firestoreCleanupStore): Promise<{ removed: number; unlinked: number }> {
    const [active, agentCvs] = await Promise.all([store.activeResumeIds(uid), store.listAgentCvs(uid)]);
    if (!agentCvs.length) return { removed: 0, unlinked: 0 };
    const legacy = agentCvs.some((cv) => !cv.sourceCvIds?.length);
    const names = legacy ? await store.activeResumeNames(uid) : new Set<string>();
    const removed: string[] = [];
    for (const cv of agentCvs) {
        if (!cv.sourceCvIds?.length) {
            // Made before ids were recorded: kept only while a resume with the same name still exists.
            if (!cv.name || !names.has(cv.name)) removed.push(cv.hash);
            continue;
        }
        const remaining = cv.sourceCvIds.filter((id) => active.has(id));
        if (!remaining.length) removed.push(cv.hash);
        else if (remaining.length !== cv.sourceCvIds.length) await store.setAgentCvSources(uid, cv.hash, remaining);
    }
    for (const hash of removed) await store.deleteAgentCv(uid, hash);
    let unlinked = 0;
    if (removed.length) {
        for (const conversation of await store.conversationsUsingCvs(uid, removed)) {
            await store.unlinkConversationCv(uid, conversation.id, JSON.parse(JSON.stringify(stripCvCards(conversation.messages))));
            unlinked++;
        }
    }
    return { removed: removed.length, unlinked };
}

export function createCleanupHandler(store: CleanupStore = firestoreCleanupStore) {
    return async (req: Request, res: Response): Promise<void> => {
        const uid = (req as Request & { user?: { uid?: string } }).user?.uid;
        if (!uid) {
            res.status(401).json({ error: 'UNAUTHORIZED' });
            return;
        }
        try {
            const result = await cleanupDeletedCvs(uid, store);
            if (result.removed) console.info('[agent] removed agent CV copies for deleted resumes', result);
            res.status(200).json(result);
        } catch {
            res.status(503).json({ error: 'INTERNAL' });
        }
    };
}

export const handleAgentCvCleanup = createCleanupHandler();
