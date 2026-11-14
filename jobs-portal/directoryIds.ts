/** Reserved public ids for Sponsorship Hub employers not in ATS `companies`. */
export const UK_REGISTER_ID_MIN = 7_000_000;
export const UK_REGISTER_ID_MAX = 7_999_999;
export const IE_REGISTER_ID_MIN = 8_000_000;
export const IE_REGISTER_ID_MAX = 8_999_999;

export function isRegisterOnlyCompanyId(id: number): boolean {
    if (!Number.isInteger(id) || id <= 0) return false;
    return (
        (id >= UK_REGISTER_ID_MIN && id <= UK_REGISTER_ID_MAX) ||
        (id >= IE_REGISTER_ID_MIN && id <= IE_REGISTER_ID_MAX)
    );
}

export function registerIdRange(catalog: 'uk' | 'ireland'): { min: number; max: number } {
    return catalog === 'ireland'
        ? { min: IE_REGISTER_ID_MIN, max: IE_REGISTER_ID_MAX }
        : { min: UK_REGISTER_ID_MIN, max: UK_REGISTER_ID_MAX };
}

const LEGAL_SUFFIX =
    /\b(limited|ltd|plc|llp|inc|incorporated|llc|gmbh|s\.?a\.?|uk)\b/gi;

export function normalizeEmployerName(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(LEGAL_SUFFIX, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isCompaniesRegisterEnabled(): boolean {
    const raw = (process.env.COMPANIES_INCLUDE_REGISTER || '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off') return false;
    return true;
}
