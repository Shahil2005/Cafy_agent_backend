import * as admin from 'firebase-admin';
import type { PriceMapping } from './priceRegistry';

const COLLECTION = 'billing_price_mappings';

function docRef(priceId: string) {
    return admin.firestore().doc(`${COLLECTION}/${priceId}`);
}

export async function getStoredPriceMapping(priceId: string): Promise<PriceMapping | null> {
    try {
        const snap = await docRef(priceId).get();
        if (!snap.exists) return null;
        const data = snap.data();
        const plan = data?.plan;
        const interval = data?.interval;
        if (
            (plan === 'premium' || plan === 'jobs_premium') &&
            (interval === 'weekly' || interval === 'monthly' || interval === 'quarterly')
        ) {
            return { plan, interval };
        }
        return null;
    } catch (err) {
        console.warn('[billing] getStoredPriceMapping failed:', priceId, err);
        return null;
    }
}

export async function storePriceMapping(priceId: string, mapping: PriceMapping): Promise<void> {
    try {
        await docRef(priceId).set(
            {
                plan: mapping.plan,
                interval: mapping.interval,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );
    } catch (err) {
        console.warn('[billing] storePriceMapping failed:', priceId, err);
    }
}

export async function listStoredPriceIds(): Promise<string[]> {
    const snap = await admin.firestore().collection(COLLECTION).listDocuments();
    return snap.map((ref) => ref.id);
}
