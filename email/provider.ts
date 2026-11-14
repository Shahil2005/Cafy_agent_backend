import { getEmailFrom, getEmailReplyTo, getResendApiKey } from './config';
import { htmlToPlainText } from './render';

export interface SendEmailInput {
    to: string;
    subject: string;
    html: string;
    unsubscribeUrl?: string;
    tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
    id: string | null;
}

export async function sendWithResend(input: SendEmailInput): Promise<SendEmailResult> {
    const apiKey = getResendApiKey();
    if (!apiKey) {
        throw new Error('RESEND_API_KEY missing');
    }

    const body: Record<string, unknown> = {
        from: getEmailFrom(),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: htmlToPlainText(input.html),
        tags: input.tags,
    };

    if (input.unsubscribeUrl) {
        body.headers = {
            'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        };
    }

    const replyTo = getEmailReplyTo();
    if (replyTo) body.reply_to = replyTo;

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    const json = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!response.ok) {
        throw new Error(json.message || json.name || `Resend HTTP ${response.status}`);
    }

    return { id: json.id || null };
}
