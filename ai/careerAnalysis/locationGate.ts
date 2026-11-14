import * as admin from 'firebase-admin';

// Mirrors the frontend's isIrelandCareerLocation() (src/utils/sponsorshipHubRouting.ts) exactly —
// canonical values are "United Kingdom"/"Ireland", but legacy profiles may hold free text.
// Northern Ireland is explicitly excluded: it's part of the UK, not the Republic of Ireland.
function isIrelandLocation(locations: unknown): boolean {
    if (!Array.isArray(locations) || locations.length === 0) return false;

    return locations.some((location) => {
        if (typeof location !== 'string') return false;
        const normalized = location.trim().toLowerCase();
        if (!normalized) return false;

        if (normalized.includes('northern ireland')) return false;
        if (normalized === 'united kingdom' || normalized === 'uk') return false;

        if (normalized === 'ireland') return true;
        if (normalized === 'republic of ireland') return true;
        if (normalized === 'éire' || normalized === 'eire') return true;

        return /\bireland\b/i.test(normalized);
    });
}

/**
 * Career Path only covers UK SOC codes / UK sponsorship data — not applicable to Ireland-based
 * job seekers. Reads the user's own stored preference server-side (never trusts client-sent
 * `preferences.locations` on the request body, which is prompt text only and easily forged).
 * Fails open to UK/allowed when unset, matching the frontend's isIrelandCareerLocation() convention.
 */
export async function isCareerAnalysisLocationBlocked(userId: string): Promise<boolean> {
    const snap = await admin.firestore().doc(`users/${userId}`).get();
    return isIrelandLocation(snap.data()?.preferences?.locations);
}
