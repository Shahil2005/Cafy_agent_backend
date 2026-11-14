/**
 * Cloudflare Turnstile Verification Service
 * 
 * This service handles server-side verification of Cloudflare Turnstile captcha tokens.
 * Documentation: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

export interface TurnstileVerificationResponse {
    success: boolean;
    challenge_ts?: string;
    hostname?: string;
    'error-codes'?: string[];
    action?: string;
    cdata?: string;
}

/**
 * Verifies a Turnstile token with Cloudflare's siteverify API
 * 
 * @param token - The Turnstile token from the client
 * @param remoteIp - Optional IP address of the user
 * @returns Promise resolving to verification result
 */
export async function verifyTurnstileToken(
    token: string,
    remoteIp?: string
): Promise<TurnstileVerificationResponse> {
    const secretKey = process.env.TURNSTILE_SECRET_KEY;

    if (!secretKey) {
        throw new Error('TURNSTILE_SECRET_KEY is not configured in environment variables');
    }

    if (!token) {
        throw new Error('Turnstile token is required');
    }

    const verificationUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token);

    if (remoteIp) {
        formData.append('remoteip', remoteIp);
    }

    try {
        const response = await fetch(verificationUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: formData.toString(),
            signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
            throw new Error(`Turnstile API returned status ${response.status}`);
        }

        const data = (await response.json()) as TurnstileVerificationResponse;

        return data;
    } catch (error) {
        console.error('Error verifying Turnstile token:', error);
        throw new Error(
            `Failed to verify Turnstile token: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

/**
 * Helper function to check if verification was successful
 */
export function isTurnstileVerified(response: TurnstileVerificationResponse): boolean {
    return response.success === true;
}
