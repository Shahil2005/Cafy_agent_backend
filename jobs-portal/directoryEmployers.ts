/**
 * Map `directory_employers` rows to the portal company DTO.
 */

import type { DirectoryPortalCompany } from './types';
import type { SupabaseClient } from '@supabase/supabase-js';

export const DIRECTORY_EMPLOYER_COLUMNS =
    'id, catalog, source, company_id, display_name, legal_name, location_city, type_rating, route, register_volume, job_count, licensed_sponsor, ireland_permit_employer, description';

export interface DirectoryEmployerRow {
    id: number;
    catalog: 'uk' | 'ireland';
    source: 'uk_home_office' | 'ie_dete' | 'jobs_catalog';
    company_id: number | null;
    display_name: string;
    legal_name: string | null;
    location_city: string | null;
    type_rating: string | null;
    route: string | null;
    register_volume: number;
    job_count: number;
    licensed_sponsor: boolean;
    ireland_permit_employer: boolean;
    description: string | null;
}

function asNumber(value: unknown, fallback = 0): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function parseDirectoryEmployerRow(raw: Record<string, unknown>): DirectoryEmployerRow | null {
    const id = Math.floor(asNumber(raw.id, 0));
    if (!Number.isInteger(id) || id <= 0) return null;
    const catalog = raw.catalog === 'ireland' ? 'ireland' : 'uk';
    const source =
        raw.source === 'ie_dete' || raw.source === 'jobs_catalog' || raw.source === 'uk_home_office'
            ? raw.source
            : catalog === 'ireland'
              ? 'ie_dete'
              : 'uk_home_office';
    const companyIdRaw = raw.company_id == null ? null : Math.floor(asNumber(raw.company_id, 0));
    const company_id =
        companyIdRaw && Number.isInteger(companyIdRaw) && companyIdRaw > 0 ? companyIdRaw : null;
    const display_name = typeof raw.display_name === 'string' ? raw.display_name.trim() : '';
    if (!display_name) return null;

    return {
        id,
        catalog,
        source,
        company_id,
        display_name,
        legal_name: typeof raw.legal_name === 'string' ? raw.legal_name : null,
        location_city: typeof raw.location_city === 'string' ? raw.location_city : null,
        type_rating: typeof raw.type_rating === 'string' ? raw.type_rating : null,
        route: typeof raw.route === 'string' ? raw.route : null,
        register_volume: Math.max(0, Math.floor(asNumber(raw.register_volume))),
        job_count: Math.max(0, Math.floor(asNumber(raw.job_count))),
        licensed_sponsor: raw.licensed_sponsor === true,
        ireland_permit_employer: raw.ireland_permit_employer === true,
        description: typeof raw.description === 'string' ? raw.description : null,
    };
}

export function directoryEmployerToPortalCompany(
    row: DirectoryEmployerRow,
    jobCount?: number
): DirectoryPortalCompany {
    const about =
        (row.description && row.description.trim()) ||
        (row.catalog === 'ireland'
            ? `${row.display_name} is on the Ireland employment-permits register${
                  row.location_city ? ` (${row.location_city})` : ''
              }.`
            : `${row.display_name} is a UK licensed sponsor${
                  row.location_city ? ` based in ${row.location_city}` : ''
              }.`);

    return {
        id: row.id,
        trading_name: row.display_name,
        companies_house_name: row.legal_name,
        url: null,
        url_linkedin: null,
        url_favicon: null,
        description: about,
        estimated_num_employees_label: null,
        licensed_sponsor: row.licensed_sponsor,
        ireland_permit_employer: row.ireland_permit_employer,
        cos_used_count_2025: row.catalog === 'uk' ? row.register_volume || null : null,
        open_to_sponsorship: null,
        show_recently_added_badge: false,
        added_to_register: null,
        active_jobs_count: Math.max(0, Math.floor(jobCount ?? row.job_count)),
    };
}

export function isDirectoryTableMissing(message: string | undefined): boolean {
    if (!message) return false;
    return /directory_employers|schema cache|does not exist|404/i.test(message);
}

export async function fetchDirectoryEmployersByIds(
    db: SupabaseClient,
    ids: number[]
): Promise<DirectoryEmployerRow[]> {
    const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (unique.length === 0) return [];

    const out: DirectoryEmployerRow[] = [];
    for (let i = 0; i < unique.length; i += 500) {
        const batch = unique.slice(i, i + 500);
        const { data, error } = await db
            .from('directory_employers')
            .select(DIRECTORY_EMPLOYER_COLUMNS)
            .in('id', batch);
        if (error) {
            if (isDirectoryTableMissing(error.message)) return [];
            console.warn('[directoryEmployers] fetch by id failed:', error.message);
            return out;
        }
        for (const raw of (data as Array<Record<string, unknown>> | null) || []) {
            const parsed = parseDirectoryEmployerRow(raw);
            if (parsed) out.push(parsed);
        }
    }
    return out;
}
