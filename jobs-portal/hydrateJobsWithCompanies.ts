import type { SupabaseClient } from '@supabase/supabase-js';
import {
    PORTAL_COMPANY_COLUMNS,
    PORTAL_COMPANY_COLUMNS_WITHOUT_IRELAND_PERMIT,
    portalJobListColumns,
    toPublicPortalCompany,
    toPublicPortalJob,
} from './publicResponse';
import type { JobsPortalJob, PublicJobsPortalCompany } from './types';
import { jobsTableForCountry, type JobsTableName } from './jobsCatalog';

const COMPANY_BATCH_SIZE = 500;

let companySelectColumns = PORTAL_COMPANY_COLUMNS;

async function selectCompanyRows(
    db: SupabaseClient,
    ids: number[]
): Promise<Record<string, unknown>[]> {
    if (ids.length === 0) return [];

    let { data, error } = await db
        .from('companies')
        .select(companySelectColumns)
        .in('id', ids);

    if (error && /ireland_permit_employer/i.test(error.message)) {
        console.warn(
            '[hydrateJobsWithCompanies] ireland_permit_employer missing — run supabase/add_ireland_permit_employer.sql'
        );
        companySelectColumns = PORTAL_COMPANY_COLUMNS_WITHOUT_IRELAND_PERMIT;
        ({ data, error } = await db
            .from('companies')
            .select(companySelectColumns)
            .in('id', ids));
    }

    if (error && /careers_url/i.test(error.message)) {
        const withoutCareers = companySelectColumns
            .split(', ')
            .filter((col) => col !== 'careers_url')
            .join(', ');
        companySelectColumns = withoutCareers;
        ({ data, error } = await db
            .from('companies')
            .select(companySelectColumns)
            .in('id', ids));
    }

    if (error) {
        console.error('[hydrateJobsWithCompanies] companies fetch error:', error.message);
        return [];
    }

    return ((data as unknown) as Record<string, unknown>[] | null) || [];
}

export async function fetchCompaniesByIds(
    db: SupabaseClient,
    ids: number[]
): Promise<PublicJobsPortalCompany[]> {
    const unique = [
        ...new Set(ids.filter((id) => Number.isFinite(id) && id > 0)),
    ];
    if (unique.length === 0) return [];

    const byId = new Map<number, PublicJobsPortalCompany>();
    for (let i = 0; i < unique.length; i += COMPANY_BATCH_SIZE) {
        const batch = unique.slice(i, i + COMPANY_BATCH_SIZE);
        const rows = await selectCompanyRows(db, batch);
        for (const row of rows) {
            const company = toPublicPortalCompany(row);
            byId.set(company.id, company);
        }
    }

    return ids
        .map((id) => byId.get(id))
        .filter((company): company is PublicJobsPortalCompany => !!company);
}

export async function fetchCompanyById(
    db: SupabaseClient,
    id: number
): Promise<PublicJobsPortalCompany | null> {
    const [company] = await fetchCompaniesByIds(db, [id]);
    return company ?? null;
}

/**
 * PostgREST embeds (`company:companies!inner(...)`) require a FK in the
 * schema cache. Some environments lack `jobs.company_id → companies.id`,
 * so we load jobs + companies separately and merge (inner-join semantics).
 */
export async function attachCompaniesToJobs(
    db: SupabaseClient,
    jobRows: Record<string, unknown>[]
): Promise<JobsPortalJob[]> {
    if (jobRows.length === 0) return [];

    const companyIds = [
        ...new Set(
            jobRows
                .map((row) => Number(row.company_id))
                .filter((id) => Number.isFinite(id) && id > 0)
        ),
    ];

    const companies = await fetchCompaniesByIds(db, companyIds);
    const companiesById = new Map(companies.map((company) => [String(company.id), company]));

    const hydrated: JobsPortalJob[] = [];
    for (const row of jobRows) {
        const company = companiesById.get(String(row.company_id));
        if (!company) continue; // match previous !inner behavior
        hydrated.push(toPublicPortalJob({ ...row, company }));
    }

    return hydrated;
}

/** Fetch jobs by id list and attach companies (no PostgREST relationship required). */
export async function fetchJobsByIdsWithCompanies(
    db: SupabaseClient,
    ids: Array<string | number>,
    jobsTable: JobsTableName = jobsTableForCountry('uk')
): Promise<JobsPortalJob[]> {
    if (ids.length === 0) return [];

    const { data, error } = await db
        .from(jobsTable)
        .select(portalJobListColumns(jobsTable))
        .in('id', ids);

    if (error) {
        const cause =
            error instanceof Error && 'cause' in error && error.cause instanceof Error
                ? ` (${error.cause.message})`
                : '';
        console.error('[hydrateJobsWithCompanies] jobs fetch error:', `${error.message}${cause}`);
        return [];
    }

    const jobs = await attachCompaniesToJobs(
        db,
        ((data as unknown) as Record<string, unknown>[] | null) || []
    );
    const byId = new Map(jobs.map((job) => [String(job.id), job]));

    // Preserve caller order
    return ids.map((id) => byId.get(String(id))).filter((job): job is JobsPortalJob => !!job);
}

/** Attach JDs to an already-capped job list (free preview only — keep premium lists light). */
export async function attachJobDescriptions(
    db: SupabaseClient,
    jobs: JobsPortalJob[],
    jobsTable: JobsTableName = jobsTableForCountry('uk')
): Promise<JobsPortalJob[]> {
    if (jobs.length === 0) return jobs;

    const ids = jobs.map((job) => job.id).filter(Boolean);
    if (ids.length === 0) return jobs;

    const { data, error } = await db
        .from(jobsTable)
        .select('id, description')
        .in('id', ids);

    if (error) {
        console.error('[hydrateJobsWithCompanies] description fetch error:', error.message);
        return jobs;
    }

    const byId = new Map<string, string>();
    for (const row of ((data as unknown) as Array<{ id?: unknown; description?: unknown }> | null) || []) {
        const id = String(row.id ?? '');
        const text = typeof row.description === 'string' ? row.description.trim() : '';
        if (id && text) byId.set(id, text);
    }

    return jobs.map((job) => {
        const description = byId.get(String(job.id));
        return description ? { ...job, description } : job;
    });
}

export async function fetchPortalJobByIdWithCompany(
    db: SupabaseClient,
    jobId: string,
    jobsTable: JobsTableName = jobsTableForCountry('uk')
): Promise<JobsPortalJob | null> {
    const { data, error } = await db
        .from(jobsTable)
        .select(portalJobListColumns(jobsTable))
        .eq('id', jobId)
        .maybeSingle();

    if (error) {
        console.error('[hydrateJobsWithCompanies] job fetch error:', error.message);
        return null;
    }
    if (!data) return null;

    const jobs = await attachCompaniesToJobs(db, [data as unknown as Record<string, unknown>]);
    return jobs[0] ?? null;
}
