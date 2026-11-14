/**
 * Conversion events for Google Analytics 4 (sign_up, activation, purchase), sent from the
 * server with the GA4 Measurement Protocol.
 *
 * Why server-side: the marketing site (www.cafy.careers) runs GA4 through GTM, but the apps
 * do not load Google Analytics. GA4 stores its visitor id in the `_ga` cookie on the parent
 * domain (.cafy.careers), so the apps can read it and send it here (POST /api/analytics/event).
 * Events sent with that client id join the same visitor in GA4, so a purchase is credited
 * to the blog post, search or ad that first brought them to the site.
 *
 * Consent: the `_ga` cookie only exists when the visitor accepted analytics cookies on the
 * marketing site. No cookie, no stored link, no event. Advertising consent is not collected,
 * so ad signals are always sent as denied.
 *
 * Config (both required, otherwise every call is a no-op):
 *   GA4_MEASUREMENT_ID   G-LJJB4G099Y
 *   GA4_API_SECRET       GA4 Admin > Data streams > www.cafy.careers > Measurement Protocol API secrets
 *
 * Analytics must never break the product: every function here swallows its own errors.
 */
import * as admin from 'firebase-admin';

export interface GaLink {
    clientId: string;
    sessionId: string | null;
}

type GaParamValue = string | number | boolean;
export type GaParams = Record<string, GaParamValue | Array<Record<string, GaParamValue>>>;

// "1234567890.1700000000" (random number . first-visit timestamp)
const CLIENT_ID_RE = /^\d{1,20}\.\d{9,11}$/;
const SESSION_ID_RE = /^\d{9,11}$/;

function config(): { measurementId: string; apiSecret: string } | null {
    const measurementId = process.env.GA4_MEASUREMENT_ID?.trim();
    const apiSecret = process.env.GA4_API_SECRET?.trim();
    return measurementId && apiSecret ? { measurementId, apiSecret } : null;
}

/** Validates the GA ids sent by the browser; anything unexpected is ignored. */
export function parseGaLink(input: unknown): GaLink | null {
    if (!input || typeof input !== 'object') return null;
    const { clientId, sessionId } = input as { clientId?: unknown; sessionId?: unknown };
    if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) return null;
    return {
        clientId,
        sessionId: typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : null,
    };
}

/** Remembers the visitor's GA ids on the user, for events that happen without a browser (Stripe webhooks). */
export async function saveGaLink(uid: string, link: GaLink): Promise<void> {
    try {
        await admin.firestore().doc(`users/${uid}`).set(
            { gaLink: { ...link, updatedAt: admin.firestore.FieldValue.serverTimestamp() } },
            { merge: true }
        );
    } catch (err) {
        console.warn('[ga4] saving GA link failed:', err);
    }
}

async function loadGaLink(uid: string): Promise<GaLink | null> {
    try {
        const snap = await admin.firestore().doc(`users/${uid}`).get();
        return parseGaLink(snap.get('gaLink'));
    } catch (err) {
        console.warn('[ga4] loading GA link failed:', err);
        return null;
    }
}

/** True the first time a key is claimed for a user, false afterwards (so each conversion is sent once). */
async function claimOnce(uid: string, key: string): Promise<boolean> {
    try {
        await admin.firestore().doc(`ga_sent_events/${uid}_${key}`).create({
            uid,
            key,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
    } catch (err) {
        const code = (err as { code?: number | string }).code;
        if (code === 6 || code === 'already-exists') return false;
        console.warn('[ga4] dedupe check failed:', err);
        return false;
    }
}

/**
 * Sends one GA4 event for a user. Uses the GA link passed in, or the one saved on the user.
 * `onceKey` makes the event fire at most once per user (sign_up, activation, purchase_<id>).
 */
export async function sendGaEvent(
    uid: string,
    name: string,
    params: GaParams,
    options: { link?: GaLink | null; onceKey?: string } = {}
): Promise<void> {
    try {
        const cfg = config();
        if (!cfg) return;
        const link = options.link ?? (await loadGaLink(uid));
        if (!link) return; // no analytics consent on the website, or never visited it
        if (options.onceKey && !(await claimOnce(uid, options.onceKey))) return;

        const body = {
            client_id: link.clientId,
            user_id: uid,
            consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
            events: [
                {
                    name,
                    params: {
                        ...params,
                        ...(link.sessionId ? { session_id: Number(link.sessionId) } : {}),
                        engagement_time_msec: 1,
                    },
                },
            ],
        };
        const url =
            `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(cfg.measurementId)}` +
            `&api_secret=${encodeURIComponent(cfg.apiSecret)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) console.warn(`[ga4] ${name} rejected: HTTP ${res.status}`);
    } catch (err) {
        console.warn(`[ga4] ${name} failed:`, err);
    }
}

/** Purchase event in GA4's ecommerce format. `transactionId` keeps it to one event per payment. */
export async function sendGaPurchase(
    uid: string,
    purchase: {
        transactionId: string;
        valuePence: number;
        currency: string;
        itemId: string;
        itemName: string;
        purchaseType: 'subscription' | 'subscription_renewal' | 'counselling';
    }
): Promise<void> {
    if (!purchase.transactionId || purchase.valuePence <= 0) return;
    const value = Math.round(purchase.valuePence) / 100;
    await sendGaEvent(
        uid,
        'purchase',
        {
            transaction_id: purchase.transactionId,
            value,
            currency: purchase.currency.toUpperCase(),
            purchase_type: purchase.purchaseType,
            items: [{ item_id: purchase.itemId, item_name: purchase.itemName, price: value, quantity: 1 }],
        },
        { onceKey: `purchase_${purchase.transactionId}` }
    );
}
