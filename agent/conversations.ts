import { randomBytes } from 'node:crypto';
import * as admin from 'firebase-admin';
import type { AgentBlock, JobListCard } from './contract';
import { nextJobLists } from './jobs/lists';

const RETENTION_DAYS = 30;
const MAX_STORED_MESSAGES = 60;

export interface StoredMessage {
    role: 'user' | 'assistant';
    text: string;
    blocks?: AgentBlock[];
    suggestions?: string[];
    at: number;
}

/** Stored at users/{uid}/agentConversations/{id}: a NEW path, written only by the agent. */
export interface Conversation {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    cvHash?: string;
    cvName?: string;
    /** Rolling summary of messages older than the recent window. */
    summary?: string;
    summarizedCount: number;
    messages: StoredMessage[];
}

export interface ConversationStore {
    get(uid: string, id: string): Promise<Conversation | null>;
    put(uid: string, conversation: Conversation): Promise<void>;
    list(uid: string, limit: number): Promise<Array<Pick<Conversation, 'id' | 'title' | 'updatedAt' | 'cvName'>>>;
    remove(uid: string, id: string): Promise<void>;
}

function collection(uid: string) {
    return admin.firestore().collection('users').doc(uid).collection('agentConversations');
}

/** Firestore rejects `undefined`; a JSON round-trip also guarantees plain data. */
function plain<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export const firestoreConversationStore: ConversationStore = {
    async get(uid, id) {
        const snap = await collection(uid).doc(id).get();
        if (!snap.exists) return null;
        const data = snap.data() as Conversation;
        return data.expiresAt < Date.now() ? null : { ...data, id };
    },
    async put(uid, conversation) {
        await collection(uid).doc(conversation.id).set(plain(conversation));
    },
    async list(uid, limit) {
        const snap = await collection(uid).orderBy('updatedAt', 'desc').limit(limit).select('title', 'updatedAt', 'expiresAt', 'cvName').get();
        const now = Date.now();
        return snap.docs
            .map((doc) => ({ id: doc.id, ...(doc.data() as Pick<Conversation, 'title' | 'updatedAt' | 'expiresAt' | 'cvName'>) }))
            .filter((c) => c.expiresAt >= now)
            .map(({ id, title, updatedAt, cvName }) => ({ id, title, updatedAt, ...(cvName ? { cvName } : {}) }));
    },
    async remove(uid, id) {
        // Deletes only the user's own conversation in the agent's own collection.
        await collection(uid).doc(id).delete();
    },
};

export function newConversation(firstMessage: string, now = Date.now()): Conversation {
    return {
        id: randomBytes(12).toString('hex'),
        title: firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New conversation',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + RETENTION_DAYS * 24 * 60 * 60 * 1000,
        summarizedCount: 0,
        messages: [],
    };
}

/** Removes the last question-and-answer pair when it is the one being regenerated. */
export function withoutLastPair(conversation: Conversation, userText: string): Conversation {
    const m = conversation.messages;
    const n = m.length;
    if (n >= 2 && m[n - 2]!.role === 'user' && m[n - 1]!.role === 'assistant' && m[n - 2]!.text === userText)
        return { ...conversation, messages: m.slice(0, n - 2) };
    return conversation;
}

/** Firestore documents are limited to 1 MiB; old messages are already covered by the rolling summary. */
const MAX_CONVERSATION_BYTES = 800_000;

/** The most recent job cards in the conversation, for "only remote", "more" and "job 2". */
export function latestJobList(conversation: Conversation): JobListCard | undefined {
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
        const block = conversation.messages[i]!.blocks?.find((b) => b.kind === 'jobList' && !b.card.pick);
        if (block?.kind === 'jobList') return block.card;
    }
    return undefined;
}

/** Recent job lists, newest first, so "job 1 from before" can be found. Recommendations are not lists. */
export function recentJobLists(conversation: Conversation, max = 3): JobListCard[] {
    return conversation.messages.reduce<JobListCard[]>((lists, message) => nextJobLists(lists, message.blocks ?? [], max), []);
}

export function appendMessages(conversation: Conversation, messages: StoredMessage[], now = Date.now()): Conversation {
    let all = [...conversation.messages, ...messages];
    let summarizedCount = conversation.summarizedCount;
    if (all.length > MAX_STORED_MESSAGES) {
        const drop = all.length - MAX_STORED_MESSAGES;
        all = all.slice(drop);
        summarizedCount = Math.max(0, summarizedCount - drop);
    }
    while (all.length > 2 && JSON.stringify(all).length > MAX_CONVERSATION_BYTES) {
        all = all.slice(2);
        summarizedCount = Math.max(0, summarizedCount - 2);
    }
    return {
        ...conversation,
        messages: all,
        summarizedCount,
        updatedAt: now,
        expiresAt: now + RETENTION_DAYS * 24 * 60 * 60 * 1000,
    };
}
