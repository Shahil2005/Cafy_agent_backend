import * as admin from 'firebase-admin';

export const SPONSORSHIP_FAVORITE_LIST_KEYS = [
    'uk-companies',
    'uk-roles',
    'ireland',
] as const;

export type SponsorshipFavoriteListKey = (typeof SPONSORSHIP_FAVORITE_LIST_KEYS)[number];

export interface SponsorshipFavoriteRecord {
    id: string;
    label: string;
    snapshot: Record<string, unknown>;
    savedAt: number;
}

const MAX_ITEMS_PER_LIST = 200;
const MAX_LABEL_LENGTH = 300;
const MAX_ID_LENGTH = 500;
const MAX_SNAPSHOT_JSON_BYTES = 8192;

function sanitizeSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> | null {
    try {
        const json = JSON.stringify(snapshot);
        if (json.length > MAX_SNAPSHOT_JSON_BYTES) return null;
        return snapshot;
    } catch {
        return null;
    }
}

function favoritesDoc(uid: string, listKey: SponsorshipFavoriteListKey) {
    return admin
        .firestore()
        .collection('users')
        .doc(uid)
        .collection('sponsorshipHubFavorites')
        .doc(listKey);
}

export function parseSponsorshipFavoriteListKey(raw: string): SponsorshipFavoriteListKey | null {
    return (SPONSORSHIP_FAVORITE_LIST_KEYS as readonly string[]).includes(raw)
        ? (raw as SponsorshipFavoriteListKey)
        : null;
}

function sanitizeFavoriteItem(raw: unknown): SponsorshipFavoriteRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, MAX_ID_LENGTH) : '';
    const label = typeof item.label === 'string' ? item.label.trim().slice(0, MAX_LABEL_LENGTH) : '';
    const savedAt = typeof item.savedAt === 'number' && Number.isFinite(item.savedAt) ? item.savedAt : 0;
    const snapshot =
        item.snapshot && typeof item.snapshot === 'object' && !Array.isArray(item.snapshot)
            ? sanitizeSnapshot(item.snapshot as Record<string, unknown>)
            : null;

    if (!id || !label || !snapshot || savedAt <= 0) return null;

    return { id, label, snapshot, savedAt };
}

export function sanitizeSponsorshipFavoriteItems(raw: unknown): SponsorshipFavoriteRecord[] {
    if (!Array.isArray(raw)) return [];

    const seen = new Set<string>();
    const items: SponsorshipFavoriteRecord[] = [];

    for (const entry of raw) {
        const item = sanitizeFavoriteItem(entry);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
        if (items.length >= MAX_ITEMS_PER_LIST) break;
    }

    return items.sort((a, b) => b.savedAt - a.savedAt);
}

export async function getSponsorshipFavorites(
    uid: string,
    listKey: SponsorshipFavoriteListKey
): Promise<{ items: SponsorshipFavoriteRecord[]; updatedAt: string | null }> {
    const snap = await favoritesDoc(uid, listKey).get();
    if (!snap.exists) {
        return { items: [], updatedAt: null };
    }

    const data = snap.data() as { items?: unknown; updatedAt?: string } | undefined;
    return {
        items: sanitizeSponsorshipFavoriteItems(data?.items),
        updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : null,
    };
}

export async function saveSponsorshipFavorites(
    uid: string,
    listKey: SponsorshipFavoriteListKey,
    rawItems: unknown
): Promise<{ items: SponsorshipFavoriteRecord[]; updatedAt: string }> {
    const items = sanitizeSponsorshipFavoriteItems(rawItems);
    const updatedAt = new Date().toISOString();

    await favoritesDoc(uid, listKey).set({ items, updatedAt }, { merge: true });

    return { items, updatedAt };
}

export async function mergeLocalSponsorshipFavorites(
    uid: string,
    listKey: SponsorshipFavoriteListKey,
    localItems: unknown
): Promise<{ items: SponsorshipFavoriteRecord[]; updatedAt: string }> {
    const remote = await getSponsorshipFavorites(uid, listKey);
    const local = sanitizeSponsorshipFavoriteItems(localItems);

    if (remote.items.length > 0) {
        return {
            items: remote.items,
            updatedAt: remote.updatedAt ?? new Date().toISOString(),
        };
    }

    if (local.length === 0) {
        return { items: [], updatedAt: new Date().toISOString() };
    }

    return saveSponsorshipFavorites(uid, listKey, local);
}
