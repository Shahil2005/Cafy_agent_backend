import Stripe from 'stripe';
import { isBillingEnabled } from './config';

let stripe: InstanceType<typeof Stripe> | null = null;

export function getStripe(): InstanceType<typeof Stripe> {
    if (!isBillingEnabled()) {
        throw new Error('BILLING_DISABLED');
    }
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
        throw new Error('STRIPE_NOT_CONFIGURED');
    }
    if (!stripe) {
        stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
    }
    return stripe;
}

export function isStripeConfigured(): boolean {
    return isBillingEnabled() && !!process.env.STRIPE_SECRET_KEY;
}
