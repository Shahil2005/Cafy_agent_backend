import crypto from 'crypto';
import { getCalComWebhookSecret } from './config';

/** Cal.com sends this when the webhook has no secret configured. */
const NO_SECRET_SENTINEL = 'no-secret-provided';

function normalizeSignatureHeader(header: string): string {
    const trimmed = header.trim();
    return trimmed.startsWith('sha256=') ? trimmed.slice(7).trim() : trimmed;
}

function timingSafeEqualHex(a: string, b: string): boolean {
    const left = a.toLowerCase().trim();
    const right = b.toLowerCase().trim();
    if (left.length !== right.length || left.length === 0) {
        return false;
    }
    if (!/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right)) {
        return false;
    }
    try {
        const leftBuf = new Uint8Array(Buffer.from(left, 'hex'));
        const rightBuf = new Uint8Array(Buffer.from(right, 'hex'));
        if (leftBuf.length !== rightBuf.length) {
            return false;
        }
        return crypto.timingSafeEqual(leftBuf, rightBuf);
    } catch {
        return false;
    }
}

/** Cal.com sends HMAC-SHA256 hex of the raw JSON body in `X-Cal-Signature-256`. */
export function verifyCalComWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    const secret = getCalComWebhookSecret();
    if (!secret) {
        return process.env.NODE_ENV !== 'production';
    }
    if (!signatureHeader?.trim()) {
        return false;
    }

    const received = normalizeSignatureHeader(signatureHeader);
    if (received === NO_SECRET_SENTINEL) {
        return false;
    }

    // Cal.com signs the JSON string payload (see createWebhookSignature in cal.com repo).
    const bodyText = rawBody.toString('utf8');
    const expected = crypto.createHmac('sha256', secret).update(bodyText).digest('hex');

    return timingSafeEqualHex(expected, received);
}
