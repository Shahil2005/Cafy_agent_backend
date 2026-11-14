export function firstNameFromDisplayName(displayName: string | null | undefined): string {
    const trimmed = (displayName || '').trim();
    if (!trimmed) return 'there';
    const token = trimmed.split(/\s+/)[0] || '';
    if (!token) return 'there';
    return token.charAt(0).toUpperCase() + token.slice(1);
}
