import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PORTAL_COMPANY_COLUMNS, toPublicPortalCompany } from './publicResponse';
import type { JobsPortalJob } from './types';

function normalizeName(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
function websiteHost(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
        return url.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return undefined;
    }
}
function client(): SupabaseClient {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Employer evidence is unavailable');
    return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
            fetch: (input, init) => {
                const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
                if (!['GET', 'HEAD'].includes(method)) throw new Error('Employer evidence permits SELECT only');
                return fetch(input, { ...init, signal: AbortSignal.timeout(5000) });
            },
        },
    });
}

/** Exact name AND website-host identity, unique within a bounded read. No name-only licence claims. */
export async function enrichChatWebEmployers(jobs: JobsPortalJob[], db?: SupabaseClient): Promise<JobsPortalJob[]> {
    if (!jobs.length) return jobs;
    const eligible = jobs.filter(
        (job) => job.listingSource && job.company?.trading_name && websiteHost(job.company.url),
    );
    const tokens = [
        ...new Set(
            eligible
                .map((job) =>
                    normalizeName(job.company!.trading_name)
                        .split(' ')
                        .find((word) => word.length > 2 && !['the', 'and', 'limited', 'ltd', 'plc'].includes(word)),
                )
                .filter((word): word is string => Boolean(word)),
        ),
    ].slice(0, 10);
    if (!tokens.length) return jobs;
    const source = db || client();
    let columns = PORTAL_COMPANY_COLUMNS;
    let rows: Record<string, unknown>[] | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await source
            .from('companies')
            .select(columns)
            .or(
                tokens
                    .flatMap((token) => [`trading_name.ilike.%${token}%`, `companies_house_name.ilike.%${token}%`])
                    .join(','),
            )
            .limit(201);
        if (!response.error) {
            // A truncated read cannot prove a unique identity; keep every licence unknown.
            if ((response.data || []).length > 200) return jobs;
            rows = (response.data || []) as unknown as Record<string, unknown>[];
            break;
        }
        const missing = ['ireland_permit_employer', 'careers_url'].find(
            (name) =>
                response.error!.message.includes(name) && columns.split(',').some((column) => column.trim() === name),
        );
        if (!missing || !['42703', 'PGRST204'].includes(response.error.code || ''))
            throw new Error('Employer evidence is unavailable');
        columns = columns
            .split(',')
            .map((column) => column.trim())
            .filter((column) => column !== missing)
            .join(', ');
    }
    if (!rows) throw new Error('Employer evidence is unavailable');
    const companies = rows.map(toPublicPortalCompany);
    return jobs.map((job) => {
        if (!job.listingSource || !job.company) return job;
        const name = normalizeName(job.company.trading_name);
        const host = websiteHost(job.company.url);
        const matches = companies.filter(
            (company) =>
                host &&
                websiteHost(company.url) === host &&
                [company.trading_name, company.companies_house_name || ''].some(
                    (value) => normalizeName(value) === name,
                ),
        );
        if (matches.length !== 1 || !matches[0]!.licensed_sponsor) return job;
        const company = matches[0]!;
        return {
            ...job,
            company_id: company.id,
            company,
            listingSource: { ...job.listingSource, employerLicence: 'catalogue-match' as const },
        };
    });
}
