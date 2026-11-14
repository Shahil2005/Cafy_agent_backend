import type { SupabaseClient } from '@supabase/supabase-js';
import { isStripeConfigured } from '../billing/stripeClient';
import { getStripe } from '../billing/stripeClient';
import {
    processCounsellingPaidCheckout,
    type CounsellingCheckoutSession,
    type CounsellingPaymentConfirmResult,
} from './paymentWebhook';

export async function syncCounsellingPaymentFromCheckoutSession(
    db: SupabaseClient,
    uid: string,
    sessionId: string
): Promise<CounsellingPaymentConfirmResult> {
    if (!isStripeConfigured()) {
        throw new Error('STRIPE_NOT_CONFIGURED');
    }

    const trimmed = sessionId.trim();
    if (!trimmed) {
        throw new Error('CHECKOUT_SESSION_INVALID');
    }

    let session: CounsellingCheckoutSession;
    try {
        session = (await getStripe().checkout.sessions.retrieve(trimmed)) as CounsellingCheckoutSession;
    } catch (err) {
        console.error('[counselling] stripe session retrieve failed', trimmed, err);
        throw new Error('CHECKOUT_SESSION_NOT_FOUND');
    }

    return processCounsellingPaidCheckout(db, session, { expectedUid: uid });
}
