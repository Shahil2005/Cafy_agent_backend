import crypto from 'crypto';
import { getCompanySiteUrl, getEmailApiPublicUrl, getUnsubscribeSecret } from './config';

function encodeUid(uid: string): string {
    return Buffer.from(uid, 'utf8').toString('base64url');
}

function decodeUid(encoded: string): string {
    return Buffer.from(encoded, 'base64url').toString('utf8');
}

export function createUnsubscribeToken(uid: string): string {
    const secret = getUnsubscribeSecret();
    if (!secret) {
        throw new Error('EMAIL_UNSUBSCRIBE_SECRET missing');
    }
    const payload = encodeUid(uid);
    const sig = crypto.createHmac('sha256', secret).update(uid).digest('base64url');
    return `${payload}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
    const secret = getUnsubscribeSecret();
    if (!secret || !token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    let uid: string;
    try {
        uid = decodeUid(payload);
    } catch {
        return null;
    }
    if (!uid) return null;
    const expected = crypto.createHmac('sha256', secret).update(uid).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    return uid;
}

export function unsubscribeUrlForUser(uid: string): string {
    const secret = getUnsubscribeSecret();
    if (!secret) {
        return `${getCompanySiteUrl()}/preferences`;
    }
    const token = createUnsubscribeToken(uid);
    return `${getEmailApiPublicUrl()}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}
