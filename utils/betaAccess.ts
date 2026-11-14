
/**
 * Check if an email is allowed to access the app
 * @param {string} email - User's email address
 * @returns {object} - { allowed: boolean, message: string }
 */
export function checkBetaAccess(email?: string): { allowed: boolean; message: string } {
    const isBetaMode = process.env.BETA_MODE === 'true';

    // If not in beta mode, everyone is allowed
    if (!isBetaMode) {
        return { allowed: true, message: 'Public access' };
    }

    // Parse the whitelist
    const betaEmails = (process.env.BETA_EMAILS || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(e => e.length > 0);

    // Check if email is in whitelist
    const normalizedEmail = email?.toLowerCase()?.trim();

    if (!normalizedEmail) {
        return {
            allowed: false,
            message: 'Email is required'
        };
    }

    if (betaEmails.includes(normalizedEmail)) {
        return {
            allowed: true,
            message: 'Beta access granted'
        };
    }

    return {
        allowed: false,
        message: 'This app is currently in beta testing. Access is limited to approved testers only.'
    };
}
