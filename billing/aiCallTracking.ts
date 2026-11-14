import * as admin from 'firebase-admin';
import type { AiCallCategory, AiCallSource } from './aiCallCategories';
import { parseAiCallCounts, type AiCallCounts } from './aiCallCategories';
import { hasActivePaidPlan, type UserSubscription } from './subscriptionService';
import { invalidateBillingStatusCache } from './statusCache';

export const AI_PROVIDERS = ['gemini', 'openai'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export type AiCallLogInput = {
    category: AiCallCategory;
    source: AiCallSource;
    route?: string;
    operation?: string;
    subcategory?: string;
    /** Platform used: gemini or openai. */
    aiProvider: AiProviderName;
    /** Specific model id, e.g. gemini-2.5-flash or gpt-4o-mini. */
    model: string;
    status: 'success' | 'error';
    latencyMs?: number;
    attempts?: number;
    fallbackUsed?: boolean;
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
};

export function normalizeAiProvider(value: unknown): AiProviderName | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'gemini' || normalized.startsWith('gemini')) return 'gemini';
    if (normalized === 'openai' || normalized.startsWith('gpt')) return 'openai';
    if ((AI_PROVIDERS as readonly string[]).includes(normalized)) {
        return normalized as AiProviderName;
    }
    return null;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) {
            out[key] = value;
        }
    }
    return out as Partial<T>;
}

function buildAiCallDoc(entry: AiCallLogInput): Record<string, unknown> {
    const providerLabel = entry.aiProvider === 'openai' ? 'OpenAI' : 'Gemini';
    return omitUndefined({
        category: entry.category,
        source: entry.source,
        route: entry.route,
        operation: entry.operation,
        subcategory: entry.subcategory,
        aiProvider: entry.aiProvider,
        model: entry.model,
        provider: entry.aiProvider,
        providerLabel,
        modelUsed: `${providerLabel} (${entry.model})`,
        status: entry.status,
        latencyMs: entry.latencyMs,
        attempts: entry.attempts,
        fallbackUsed: entry.fallbackUsed,
        promptTokenCount: entry.promptTokenCount,
        candidatesTokenCount: entry.candidatesTokenCount,
        totalTokenCount: entry.totalTokenCount,
    });
}

/**
 * Persist one AI call under `users/{uid}/aiCalls` for paid subscribers only.
 * Failures are logged and swallowed so tracking never blocks user flows.
 */
export async function recordAiCallIfPaid(
    uid: string,
    subscription: UserSubscription,
    entry: AiCallLogInput
): Promise<string | null> {
    if (!hasActivePaidPlan(subscription)) {
        return null;
    }

    const ref = admin.firestore().collection('users').doc(uid).collection('aiCalls').doc();
    const userRef = admin.firestore().doc(`users/${uid}`);
    const batch = admin.firestore().batch();

    batch.set(ref, {
        ...buildAiCallDoc(entry),
        plan: subscription.plan,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(
        userRef,
        {
            usage: {
                aiCallCounts: {
                    [entry.category]: admin.firestore.FieldValue.increment(1),
                },
                aiCallCountsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
        },
        { merge: true }
    );

    await batch.commit();
    invalidateBillingStatusCache(uid);

    return ref.id;
}

export async function getUserAiCallCounts(
    uid: string,
    preloadedData?: FirebaseFirestore.DocumentData | null
): Promise<AiCallCounts> {
    if (preloadedData) {
        return parseAiCallCounts(preloadedData?.usage?.aiCallCounts);
    }
    const snap = await admin.firestore().doc(`users/${uid}`).get();
    return parseAiCallCounts(snap.data()?.usage?.aiCallCounts);
}

export async function recordAiCallForUser(uid: string, entry: AiCallLogInput): Promise<string | null> {
    try {
        const userSnap = await admin.firestore().doc(`users/${uid}`).get();
        const subscription = (userSnap.data()?.subscription || {}) as UserSubscription;
        return await recordAiCallIfPaid(uid, subscription, entry);
    } catch (error) {
        console.warn('[ai-calls] Failed to record AI call:', error);
        return null;
    }
}
