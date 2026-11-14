export type EmailCampaign =
    | 'premiumEndedNotice'
    | 'winbackPremium'
    | 'freeUsageNotice'
    | 'freeUsageNudge'
    | 'onboardingReminder'
    | 'purchaseGuide'
    | 'verifyReminder';

const DEFAULT_OFFER_DELAY_MS = 4 * 60 * 60 * 1000;

export function isEmailSendingEnabled(): boolean {
    return process.env.EMAIL_SENDING_ENABLED === 'true';
}

export function getResendApiKey(): string | undefined {
    const key = process.env.RESEND_API_KEY?.trim();
    return key || undefined;
}

export function getEmailFrom(): string {
    return process.env.EMAIL_FROM?.trim() || 'Cafy <admin@cafy.careers>';
}

export function getEmailReplyTo(): string | undefined {
    const value = process.env.EMAIL_REPLY_TO?.trim();
    return value || 'admin@cafy.careers';
}

export function getUnsubscribeSecret(): string | undefined {
    const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
    return secret || undefined;
}

export function getEmailAllowlist(): string[] {
    return (process.env.EMAIL_ALLOWLIST || '')
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}

export function getEmailApiPublicUrl(): string {
    return (process.env.EMAIL_API_PUBLIC_URL || 'https://api.cafy.careers').replace(/\/$/, '');
}

export function getCompanySiteUrl(): string {
    return (process.env.COMPANY_SITE_URL || 'https://www.cafy.careers').replace(/\/$/, '');
}

export function getAppUrl(): string {
    return (process.env.FRONTEND_URL || 'https://app.cafy.careers')
        .split(',')[0]
        .trim()
        .replace(/\/$/, '') || 'https://app.cafy.careers';
}

export function isRecipientAllowed(email: string): boolean {
    const allowlist = getEmailAllowlist();
    if (allowlist.length === 0) return true;
    return allowlist.includes(email.trim().toLowerCase());
}

/** Delay before the marketing follow-up of a status + offer pair. */
export function getOfferDelayMs(): number {
    const raw = process.env.EMAIL_OFFER_DELAY_MS?.trim();
    if (!raw) return DEFAULT_OFFER_DELAY_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_OFFER_DELAY_MS;
    return parsed;
}
