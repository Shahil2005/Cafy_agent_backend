import { resolveJobsCatalogCountry } from './jobsCatalog';

/** Saved profile locations only. Request query values are never accepted. */
export function partTimeLocationsFromProfile(
    data: { preferences?: { locations?: unknown } } | undefined,
): string[] {
    const locations = data?.preferences?.locations;
    if (!Array.isArray(locations)) return [];
    return locations.filter((value): value is string => typeof value === 'string');
}

/**
 * Republic of Ireland profiles use the Ireland jobs catalog.
 * Empty or unrecognized locations stay on the United Kingdom catalog.
 * Northern Ireland is not the Republic of Ireland.
 */
export function isIrelandCatalogProfile(
    data: { preferences?: { locations?: unknown } } | undefined,
): boolean {
    return resolveJobsCatalogCountry(partTimeLocationsFromProfile(data)) === 'ireland';
}

/** Republic of Ireland profiles cannot use the part-time jobs catalog. */
export function isPartTimeJobsBlocked(
    data: { preferences?: { locations?: unknown } } | undefined,
): boolean {
    return isIrelandCatalogProfile(data);
}
