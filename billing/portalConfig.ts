import { getStripe } from './stripeClient';

/**
 * Stripe Customer Portal requires an active Dashboard configuration.
 * Without it, billing.stripe.com can fail client init (client_init_timeout_report).
 */
export async function resolveBillingPortalConfigurationId(): Promise<string> {
    const envId = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim();
    if (envId) return envId;

    const { data } = await getStripe().billingPortal.configurations.list({ limit: 10 });
    const active =
        data.find((config) => config.is_default) ??
        data.find((config) => config.active !== false) ??
        data[0];

    if (!active?.id) {
        throw new Error('PORTAL_NOT_CONFIGURED');
    }

    return active.id;
}

export function assertStripeHostedUrl(url: string, kind: 'checkout' | 'portal'): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`${kind === 'portal' ? 'PORTAL' : 'CHECKOUT'}_URL_INVALID`);
    }

    if (parsed.protocol !== 'https:') {
        throw new Error(`${kind === 'portal' ? 'PORTAL' : 'CHECKOUT'}_URL_INVALID`);
    }

    const hostOk =
        kind === 'portal'
            ? parsed.hostname === 'billing.stripe.com'
            : parsed.hostname === 'checkout.stripe.com';

    if (!hostOk) {
        throw new Error(`${kind === 'portal' ? 'PORTAL' : 'CHECKOUT'}_URL_INVALID`);
    }
}
