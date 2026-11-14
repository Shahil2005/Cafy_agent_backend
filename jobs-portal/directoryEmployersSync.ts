/**
 * Idempotent directory sync: Sponsorship Hub registers + jobs-catalog sponsors.
 * Failed file parse aborts without deleting existing rows.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { jobsTableForCountry, type JobsCatalogCountry } from './jobsCatalog';
import {
    isDirectoryTableMissing,
} from './directoryEmployers';
import {
    isRegisterOnlyCompanyId,
    normalizeEmployerName,
    registerIdRange,
} from './directoryIds';
import { listIrelandSponsorshipRegister } from './irelandSponsorship';
import { listUkSponsorshipRegister } from './service';

const UPSERT_BATCH = 200;
const COMPANY_PAGE = 1_000;
const JOB_PAGE = 1_000;

export interface DirectoryEmployerWrite {
    id: number;
    catalog: JobsCatalogCountry;
    source: 'uk_home_office' | 'ie_dete' | 'jobs_catalog';
    company_id: string | null;
    display_name: string;
    normalized_name: string;
    legal_name: string | null;
    location_city: string | null;
    type_rating: string | null;
    route: string | null;
    register_volume: number;
    job_count: number;
    licensed_sponsor: boolean;
    ireland_permit_employer: boolean;
    description: string | null;
    synced_at: string;
    updated_at: string;
}

export interface DirectorySyncResult {
    ok: boolean;
    skipped?: string;
    ukRegister: number;
    irelandRegister: number;
    matched: number;
    registerOnly: number;
    jobsCatalogExtra: number;
    upserted: number;
    deleted: number;
    durationMs: number;
}

interface CatalogCompany {
    id: number;
    idKey: string;
    trading_name: string;
    companies_house_name: string | null;
    licensed_sponsor: boolean;
    ireland_permit_employer: boolean;
    cos_used_count_2025: number | null;
    description: string | null;
}

function getSupabaseAdmin(): SupabaseClient {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
    }
    return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
}

function isIrelandSeedId(id: number): boolean {
    return id >= 900_000 && id < 7_000_000;
}

async function loadCatalogCompanies(db: SupabaseClient): Promise<CatalogCompany[]> {
    const out: CatalogCompany[] = [];
    let from = 0;
    while (from < 500_000) {
        const to = from + COMPANY_PAGE - 1;
        const first = await db
            .from('companies')
            .select(
                'id, trading_name, companies_house_name, licensed_sponsor, ireland_permit_employer, cos_used_count_2025, description'
            )
            .order('id', { ascending: true })
            .range(from, to);

        let data: unknown = first.data;
        let error = first.error;

        if (error && /ireland_permit_employer/i.test(error.message)) {
            const retry = await db
                .from('companies')
                .select(
                    'id, trading_name, companies_house_name, licensed_sponsor, cos_used_count_2025, description'
                )
                .order('id', { ascending: true })
                .range(from, to);
            data = retry.data;
            error = retry.error;
        }

        if (error) {
            throw new Error(`companies scan failed: ${error.message}`);
        }

        const rows = (data as Array<Record<string, unknown>> | null) || [];
        if (rows.length === 0) break;

        for (const row of rows) {
            const idKey = row.id == null ? '' : String(row.id).trim();
            const id = Number(idKey);
            if (!idKey || !Number.isInteger(id) || id <= 0) continue;
            out.push({
                id,
                idKey,
                trading_name: typeof row.trading_name === 'string' ? row.trading_name : '',
                companies_house_name:
                    typeof row.companies_house_name === 'string' ? row.companies_house_name : null,
                licensed_sponsor: row.licensed_sponsor === true || row.licensed_sponsor === 'true',
                ireland_permit_employer:
                    row.ireland_permit_employer === true || row.ireland_permit_employer === 'true',
                cos_used_count_2025:
                    typeof row.cos_used_count_2025 === 'number'
                        ? row.cos_used_count_2025
                        : Number(row.cos_used_count_2025) || null,
                description: typeof row.description === 'string' ? row.description : null,
            });
        }

        if (rows.length < COMPANY_PAGE) break;
        from += COMPANY_PAGE;
    }
    return out;
}

async function loadJobCounts(
    db: SupabaseClient,
    catalog: JobsCatalogCountry
): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    const table = jobsTableForCountry(catalog);
    let from = 0;
    while (from < 500_000) {
        const to = from + JOB_PAGE - 1;
        const { data, error } = await db
            .from(table)
            .select('company_id')
            .order('id', { ascending: true })
            .range(from, to);
        if (error) {
            console.warn('[directorySync] job count scan failed:', error.message);
            break;
        }
        const rows = (data as Array<{ company_id?: number }> | null) || [];
        if (rows.length === 0) break;
        for (const row of rows) {
            const id = Number(row.company_id);
            if (!Number.isInteger(id) || id <= 0) continue;
            counts.set(id, (counts.get(id) || 0) + 1);
        }
        if (rows.length < JOB_PAGE) break;
        from += JOB_PAGE;
    }
    return counts;
}

async function loadExistingDirectory(
    db: SupabaseClient
): Promise<Map<string, { id: number; catalog: JobsCatalogCountry }>> {
    const map = new Map<string, { id: number; catalog: JobsCatalogCountry }>();
    let from = 0;
    while (from < 500_000) {
        const to = from + COMPANY_PAGE - 1;
        const { data, error } = await db
            .from('directory_employers')
            .select('id, catalog, normalized_name')
            .order('id', { ascending: true })
            .range(from, to);
        if (error) {
            if (isDirectoryTableMissing(error.message)) {
                throw new Error(
                    'directory_employers missing — run jobs-portal/sql/directory_employers.sql'
                );
            }
            throw new Error(error.message);
        }
        const rows = (data as Array<Record<string, unknown>> | null) || [];
        if (rows.length === 0) break;
        for (const row of rows) {
            const id = Number(row.id);
            const catalog = row.catalog === 'ireland' ? 'ireland' : 'uk';
            const norm = typeof row.normalized_name === 'string' ? row.normalized_name : '';
            if (!Number.isInteger(id) || !norm) continue;
            map.set(`${catalog}:${norm}`, { id, catalog });
        }
        if (rows.length < COMPANY_PAGE) break;
        from += COMPANY_PAGE;
    }
    return map;
}

function nameIndex(companies: CatalogCompany[], catalog: JobsCatalogCountry): Map<string, CatalogCompany> {
    const index = new Map<string, CatalogCompany>();
    for (const company of companies) {
        const irelandish = isIrelandSeedId(company.id) || company.ireland_permit_employer;
        if (catalog === 'ireland' && !irelandish) continue;
        if (catalog === 'uk' && irelandish && !company.licensed_sponsor) continue;
        for (const raw of [company.trading_name, company.companies_house_name]) {
            if (!raw) continue;
            const key = normalizeEmployerName(raw);
            if (!key || index.has(key)) continue;
            index.set(key, company);
        }
    }
    return index;
}

function registerBlurb(input: {
    catalog: JobsCatalogCountry;
    displayName: string;
    city: string | null;
}): string {
    if (input.catalog === 'ireland') {
        return `${input.displayName} is on the Ireland employment-permits register${
            input.city ? ` (${input.city})` : ''
        }.`;
    }
    return `${input.displayName} is a UK licensed sponsor${
        input.city ? ` based in ${input.city}` : ''
    }.`;
}

function toUpsertPayload(
    row: DirectoryEmployerWrite,
    knownCompanyIds: Set<string>
): Record<string, unknown> {
    const companyId =
        row.company_id && knownCompanyIds.has(row.company_id) ? row.company_id : null;
    return {
        ...row,
        company_id: companyId,
    };
}

async function upsertBatches(
    db: SupabaseClient,
    rows: DirectoryEmployerWrite[],
    knownCompanyIds: Set<string>
): Promise<number> {
    let upserted = 0;
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH).map((row) => toUpsertPayload(row, knownCompanyIds));
        let { error } = await db.from('directory_employers').upsert(batch, {
            onConflict: 'catalog,normalized_name',
        });
        if (error && /directory_employers_company_id_fkey/i.test(error.message)) {
            const dropped = batch.filter((row) => row.company_id != null).length;
            console.warn('[directorySync] FK miss on company_id — retrying batch without ATS links', {
                dropped,
                offset: i,
            });
            ({ error } = await db.from('directory_employers').upsert(
                batch.map((row) => ({ ...row, company_id: null })),
                { onConflict: 'catalog,normalized_name' }
            ));
        }
        if (error) {
            throw new Error(`directory upsert failed: ${error.message}`);
        }
        upserted += batch.length;
    }
    return upserted;
}

export async function syncDirectoryEmployers(): Promise<DirectorySyncResult> {
    const started = Date.now();
    const syncedAt = new Date().toISOString();
    const db = getSupabaseAdmin();

    const [ukRegister, irelandRegister, companies] = await Promise.all([
        listUkSponsorshipRegister(),
        listIrelandSponsorshipRegister(),
        loadCatalogCompanies(db),
    ]);

    if (ukRegister.length < 1_000) {
        console.warn('[directorySync] abort: UK register too small', ukRegister.length);
        return {
            ok: false,
            skipped: `uk register too small (${ukRegister.length})`,
            ukRegister: ukRegister.length,
            irelandRegister: irelandRegister.length,
            matched: 0,
            registerOnly: 0,
            jobsCatalogExtra: 0,
            upserted: 0,
            deleted: 0,
            durationMs: Date.now() - started,
        };
    }
    if (irelandRegister.length < 100) {
        console.warn('[directorySync] abort: Ireland register too small', irelandRegister.length);
        return {
            ok: false,
            skipped: `ireland register too small (${irelandRegister.length})`,
            ukRegister: ukRegister.length,
            irelandRegister: irelandRegister.length,
            matched: 0,
            registerOnly: 0,
            jobsCatalogExtra: 0,
            upserted: 0,
            deleted: 0,
            durationMs: Date.now() - started,
        };
    }

    const [ukJobs, ieJobs, existing] = await Promise.all([
        loadJobCounts(db, 'uk'),
        loadJobCounts(db, 'ireland'),
        loadExistingDirectory(db),
    ]);

    const ukNames = nameIndex(companies, 'uk');
    const ieNames = nameIndex(companies, 'ireland');

    let nextUk = registerIdRange('uk').min;
    let nextIe = registerIdRange('ireland').min;
    for (const row of existing.values()) {
        if (row.catalog === 'uk' && isRegisterOnlyCompanyId(row.id)) {
            nextUk = Math.max(nextUk, row.id + 1);
        }
        if (row.catalog === 'ireland' && isRegisterOnlyCompanyId(row.id)) {
            nextIe = Math.max(nextIe, row.id + 1);
        }
    }

    const usedCompanyIds = new Set<string>();
    const writes = new Map<string, DirectoryEmployerWrite>();
    const writesByCompany = new Map<string, DirectoryEmployerWrite>();
    let matched = 0;
    let registerOnly = 0;
    let jobsCatalogExtra = 0;

    const mergeInto = (prev: DirectoryEmployerWrite, row: DirectoryEmployerWrite) => {
        prev.register_volume = Math.max(prev.register_volume, row.register_volume);
        prev.job_count = Math.max(prev.job_count, row.job_count);
        if (row.licensed_sponsor) prev.licensed_sponsor = true;
        if (row.ireland_permit_employer) prev.ireland_permit_employer = true;
        if (!prev.company_id && row.company_id) {
            prev.company_id = row.company_id;
            prev.id = row.id;
            prev.source = row.source;
            prev.job_count = Math.max(prev.job_count, row.job_count);
        }
        if (!prev.legal_name && row.legal_name) prev.legal_name = row.legal_name;
        if (!prev.location_city && row.location_city) prev.location_city = row.location_city;
        if (!prev.description && row.description) prev.description = row.description;
    };

    const addRow = (row: DirectoryEmployerWrite) => {
        const nameKey = `${row.catalog}:${row.normalized_name}`;
        const companyKey =
            row.company_id != null ? `${row.catalog}:cid:${row.company_id}` : null;

        if (companyKey && writesByCompany.has(companyKey)) {
            mergeInto(writesByCompany.get(companyKey)!, row);
            return;
        }

        const prev = writes.get(nameKey);
        if (prev) {
            mergeInto(prev, row);
            if (companyKey) writesByCompany.set(companyKey, prev);
            return;
        }

        writes.set(nameKey, row);
        if (companyKey) writesByCompany.set(companyKey, row);
    };

    const assignId = (
        catalog: JobsCatalogCountry,
        normalized: string,
        matchedCompanyId: number | null
    ): number => {
        const existingId = existing.get(`${catalog}:${normalized}`)?.id;
        if (existingId) return existingId;
        if (matchedCompanyId) return matchedCompanyId;
        if (catalog === 'ireland') {
            const id = nextIe;
            nextIe += 1;
            return id;
        }
        const id = nextUk;
        nextUk += 1;
        return id;
    };

    for (const org of ukRegister) {
        const normalized = normalizeEmployerName(org.organisationName);
        if (!normalized) continue;
        const hit = ukNames.get(normalized);
        const companyKey = hit ? `uk:${hit.idKey}` : null;
        if (companyKey && usedCompanyIds.has(companyKey)) {
            const existingWrite = [...writes.values()].find(
                (w) => w.company_id === hit!.idKey && w.catalog === 'uk'
            );
            if (existingWrite) {
                existingWrite.register_volume = Math.max(existingWrite.register_volume, 1);
            }
            continue;
        }
        const company_id = hit?.idKey ?? null;
        if (company_id) {
            usedCompanyIds.add(`uk:${company_id}`);
            matched += 1;
        } else {
            registerOnly += 1;
        }
        const id = assignId('uk', normalized, hit?.id ?? null);
        addRow({
            id,
            catalog: 'uk',
            source: 'uk_home_office',
            company_id,
            display_name: org.organisationName.trim(),
            normalized_name: normalized,
            legal_name: hit?.companies_house_name ?? null,
            location_city: org.townCity || null,
            type_rating: org.typeRating || null,
            route: org.route || null,
            register_volume: Math.max(0, hit?.cos_used_count_2025 || 0),
            job_count: hit ? ukJobs.get(hit.id) || 0 : 0,
            licensed_sponsor: true,
            ireland_permit_employer: false,
            description: hit?.description || registerBlurb({
                catalog: 'uk',
                displayName: org.organisationName,
                city: org.townCity || null,
            }),
            synced_at: syncedAt,
            updated_at: syncedAt,
        });
    }

    for (const org of irelandRegister) {
        const normalized = normalizeEmployerName(org.employerName);
        if (!normalized) continue;
        const hit = ieNames.get(normalized);
        const companyKey = hit ? `ireland:${hit.idKey}` : null;
        if (companyKey && usedCompanyIds.has(companyKey)) {
            const existingWrite = [...writes.values()].find(
                (w) => w.company_id === hit!.idKey && w.catalog === 'ireland'
            );
            if (existingWrite) {
                existingWrite.register_volume = Math.max(
                    existingWrite.register_volume,
                    org.totalPermits
                );
            }
            continue;
        }
        const company_id = hit?.idKey ?? null;
        if (company_id) {
            usedCompanyIds.add(`ireland:${company_id}`);
            matched += 1;
        } else {
            registerOnly += 1;
        }
        const id = assignId('ireland', normalized, hit?.id ?? null);
        addRow({
            id,
            catalog: 'ireland',
            source: 'ie_dete',
            company_id,
            display_name: org.employerName.trim(),
            normalized_name: normalized,
            legal_name: hit?.companies_house_name ?? null,
            location_city: org.city,
            type_rating: null,
            route: null,
            register_volume: Math.max(0, org.totalPermits),
            job_count: hit ? ieJobs.get(hit.id) || 0 : 0,
            licensed_sponsor: false,
            ireland_permit_employer: true,
            description: hit?.description || registerBlurb({
                catalog: 'ireland',
                displayName: org.employerName,
                city: org.city,
            }),
            synced_at: syncedAt,
            updated_at: syncedAt,
        });
    }

    for (const company of companies) {
        const normalized = normalizeEmployerName(company.trading_name);
        if (!normalized) continue;

        if (company.licensed_sponsor && !usedCompanyIds.has(`uk:${company.idKey}`)) {
            usedCompanyIds.add(`uk:${company.idKey}`);
            jobsCatalogExtra += 1;
            addRow({
                id: existing.get(`uk:${normalized}`)?.id || company.id,
                catalog: 'uk',
                source: 'jobs_catalog',
                company_id: company.idKey,
                display_name: company.trading_name,
                normalized_name: normalized,
                legal_name: company.companies_house_name,
                location_city: null,
                type_rating: null,
                route: null,
                register_volume: Math.max(0, company.cos_used_count_2025 || 0),
                job_count: ukJobs.get(company.id) || 0,
                licensed_sponsor: true,
                ireland_permit_employer: false,
                description: company.description,
                synced_at: syncedAt,
                updated_at: syncedAt,
            });
        }

        if (
            (company.ireland_permit_employer || isIrelandSeedId(company.id)) &&
            !usedCompanyIds.has(`ireland:${company.idKey}`)
        ) {
            usedCompanyIds.add(`ireland:${company.idKey}`);
            jobsCatalogExtra += 1;
            addRow({
                id: existing.get(`ireland:${normalized}`)?.id || company.id,
                catalog: 'ireland',
                source: 'jobs_catalog',
                company_id: company.idKey,
                display_name: company.trading_name,
                normalized_name: normalized,
                legal_name: company.companies_house_name,
                location_city: null,
                type_rating: null,
                route: null,
                register_volume: 0,
                job_count: ieJobs.get(company.id) || 0,
                licensed_sponsor: false,
                ireland_permit_employer: true,
                description: company.description,
                synced_at: syncedAt,
                updated_at: syncedAt,
            });
        }
    }

    const knownCompanyIds = new Set(companies.map((company) => company.idKey));
    const rows = [...writes.values()];
    const upserted = await upsertBatches(db, rows, knownCompanyIds);

    const { data: stale, error: staleError } = await db
        .from('directory_employers')
        .delete()
        .lt('synced_at', syncedAt)
        .select('id');

    if (staleError) {
        console.warn('[directorySync] stale delete failed:', staleError.message);
    }

    try {
        const { clearCompanyJobCountsCache, listPortalCompanies } = await import('./companiesDirectory');
        await clearCompanyJobCountsCache();
        await Promise.all([
            listPortalCompanies({ catalogCountry: 'uk', page: 1 }),
            listPortalCompanies({ catalogCountry: 'ireland', page: 1 }),
        ]);
    } catch (err) {
        console.warn('[directorySync] cache warm failed:', err);
    }

    const result: DirectorySyncResult = {
        ok: true,
        ukRegister: ukRegister.length,
        irelandRegister: irelandRegister.length,
        matched,
        registerOnly,
        jobsCatalogExtra,
        upserted,
        deleted: Array.isArray(stale) ? stale.length : 0,
        durationMs: Date.now() - started,
    };
    console.info('[directorySync]', result);
    return result;
}
