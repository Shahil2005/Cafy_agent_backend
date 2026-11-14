import * as admin from 'firebase-admin';
import type { JobType, Sector } from './constants';
import { sanitizeUserSectors } from './sectorPreferences';
import { sanitizeUserExperienceLevels } from './levelMapping';
import { sanitizeUserJobTypes } from './jobTypeMapping';
import {
    resolveJobsCatalogCountry,
    type JobsCatalogCountry,
} from './jobsCatalog';

const PORTAL_PREFS_DOC = (uid: string) => `users/${uid}/jobPortalPreferences/settings`;
const USER_DOC = (uid: string) => `users/${uid}`;

export interface StoredUserPreferences {
    jobTypes?: string[];
    experienceLevel?: string[];
    searchStatus?: string;
    locations?: string[];
    sectors?: string[];
    roles?: string[];
    sponsorship?: string;
    updatedAt?: string;
}

export interface CareerBrowsePreferences {
    sectors: Sector[];
    experienceLevels: string[];
    jobTypes: JobType[];
    /** Target career country locations from profile (e.g. ["Ireland"]). */
    locations: string[];
    /** Resolved jobs catalog for this user. */
    catalogCountry: JobsCatalogCountry;
    updatedAt: string | null;
}

function getFirestoreDb(): admin.firestore.Firestore {
    return admin.firestore();
}

function parseTimestamp(iso: string | undefined | null): number {
    if (!iso) return 0;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
}

function asStringArray(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) return value.map((v) => String(v));
    return [String(value)];
}

/**
 * Resolve sectors when legacy portal doc and profile both exist.
 * Prefer the source with the newer `updatedAt`; profile wins ties.
 */
export function mergeSectorSources(params: {
    profileSectors: string[] | undefined | null;
    profileUpdatedAt: string | undefined | null;
    portalSectors: string[] | undefined | null;
    portalUpdatedAt: string | undefined | null;
}): Sector[] {
    const profile = sanitizeUserSectors(params.profileSectors);
    const portal = sanitizeUserSectors(params.portalSectors);

    if (!portal.length) return profile;
    if (!profile.length) return portal;

    const portalTs = parseTimestamp(params.portalUpdatedAt);
    const profileTs = parseTimestamp(params.profileUpdatedAt);
    return portalTs > profileTs ? portal : profile;
}

function sanitizeLocations(value: unknown): string[] {
    return asStringArray(value)
        .map((v) => v.trim())
        .filter(Boolean);
}

function toCareerBrowsePreferences(prefs: StoredUserPreferences | null | undefined): CareerBrowsePreferences {
    if (!prefs) {
        return {
            sectors: [],
            experienceLevels: [],
            jobTypes: [],
            locations: [],
            catalogCountry: 'uk',
            updatedAt: null,
        };
    }
    const locations = sanitizeLocations(prefs.locations);
    return {
        sectors: sanitizeUserSectors(prefs.sectors),
        experienceLevels: sanitizeUserExperienceLevels(prefs.experienceLevel),
        jobTypes: sanitizeUserJobTypes(prefs.jobTypes),
        locations,
        catalogCountry: resolveJobsCatalogCountry(locations),
        updatedAt: prefs.updatedAt ?? null,
    };
}

/**
 * Lazy migration: merge legacy `jobPortalPreferences/settings` into profile, then delete portal doc.
 * Returns the effective stored preferences object (may be empty).
 *
 * Pass `preloadedUserData` when users/{uid} was already loaded in this request.
 * Once `preferencesPortalCleared` is stamped, skip the legacy portal doc read.
 */
export async function loadStoredUserPreferences(
    uid: string,
    preloadedUserData?: FirebaseFirestore.DocumentData | null
): Promise<StoredUserPreferences | null> {
    const firestore = getFirestoreDb();
    const userRef = firestore.doc(USER_DOC(uid));
    const portalRef = firestore.doc(PORTAL_PREFS_DOC(uid));

    const userData =
        preloadedUserData ?? (await userRef.get()).data();
    const existing = (userData?.preferences ?? null) as StoredUserPreferences | null;

    if (userData?.preferencesPortalCleared === true) {
        return existing;
    }

    const portalSnap = await portalRef.get();

    if (!portalSnap.exists) {
        void userRef.set({ preferencesPortalCleared: true }, { merge: true }).catch(() => {
            /* non-blocking */
        });
        return existing;
    }

    const portalData = portalSnap.data() as { sectors?: unknown[]; updatedAt?: string } | undefined;
    const mergedSectors = mergeSectorSources({
        profileSectors: existing?.sectors,
        profileUpdatedAt: existing?.updatedAt,
        portalSectors: asStringArray(portalData?.sectors),
        portalUpdatedAt: portalData?.updatedAt,
    });

    const merged: StoredUserPreferences = {
        ...(existing ?? {}),
        sectors: mergedSectors,
        updatedAt: new Date().toISOString(),
    };

    const batch = firestore.batch();
    batch.set(
        userRef,
        { preferences: merged, preferencesPortalCleared: true },
        { merge: true }
    );
    batch.delete(portalRef);
    await batch.commit();

    return merged;
}

/** Sectors + experience levels used for jobs browse feed ranking. */
export async function getCareerBrowsePreferences(
    uid: string,
    preloadedUserData?: FirebaseFirestore.DocumentData | null
): Promise<CareerBrowsePreferences> {
    try {
        const stored = await loadStoredUserPreferences(uid, preloadedUserData);
        return toCareerBrowsePreferences(stored);
    } catch (err) {
        console.error('[userPreferences] getCareerBrowsePreferences error:', err);
        return { sectors: [], experienceLevels: [], jobTypes: [], locations: [], catalogCountry: 'uk', updatedAt: null };
    }
}

export async function resolveUserBrowseSectors(uid: string): Promise<Sector[]> {
    const prefs = await getCareerBrowsePreferences(uid);
    return prefs.sectors;
}

export async function resolveUserBrowseExperienceLevels(uid: string): Promise<string[]> {
    const prefs = await getCareerBrowsePreferences(uid);
    return prefs.experienceLevels;
}

/** Merge validated browse fields into `users/{uid}.preferences`. */
export async function saveCareerBrowsePreferences(
    uid: string,
    raw: {
        sectors?: string[] | null;
        experienceLevels?: string[] | null;
        jobTypes?: string[] | null;
    }
): Promise<{ success: boolean; error?: string }> {
    try {
        const firestore = getFirestoreDb();
        const userRef = firestore.doc(USER_DOC(uid));
        const userSnap = await userRef.get();
        const existing = (userSnap.data()?.preferences ?? {}) as StoredUserPreferences;

        const merged: StoredUserPreferences = {
            ...existing,
            updatedAt: new Date().toISOString(),
        };

        if (raw.sectors !== undefined) {
            merged.sectors = sanitizeUserSectors(raw.sectors);
        }
        if (raw.experienceLevels !== undefined) {
            merged.experienceLevel = sanitizeUserExperienceLevels(raw.experienceLevels);
        }
        if (raw.jobTypes !== undefined) {
            merged.jobTypes = sanitizeUserJobTypes(raw.jobTypes);
        }

        await userRef.set({ preferences: merged }, { merge: true });
        return { success: true };
    } catch (err) {
        console.error('[userPreferences] saveCareerBrowsePreferences error:', err);
        return { success: false, error: 'Failed to save preferences' };
    }
}

/** @deprecated Use getCareerBrowsePreferences — kept for API compatibility. */
export async function getUserPreferences(uid: string): Promise<{
    sectors: Sector[];
    experienceLevels: string[];
    jobTypes: JobType[];
    updatedAt: string;
} | null> {
    const prefs = await getCareerBrowsePreferences(uid);
    if (!prefs.sectors.length && !prefs.experienceLevels.length && !prefs.jobTypes.length) {
        return null;
    }
    return {
        sectors: prefs.sectors,
        experienceLevels: prefs.experienceLevels,
        jobTypes: prefs.jobTypes,
        updatedAt: prefs.updatedAt ?? new Date().toISOString(),
    };
}

/** @deprecated Use saveCareerBrowsePreferences — kept for API compatibility. */
export async function saveUserPreferences(
    uid: string,
    raw: { sectors?: string[]; experienceLevels?: string[]; jobTypes?: string[] }
): Promise<{ success: boolean; error?: string }> {
    return saveCareerBrowsePreferences(uid, {
        sectors: raw.sectors,
        experienceLevels: raw.experienceLevels,
        jobTypes: raw.jobTypes,
    });
}
