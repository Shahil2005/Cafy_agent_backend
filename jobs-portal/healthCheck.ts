import { searchJobsPageRpc } from './jobsCatalog';
/** Lightweight probe that ranked search RPCs are deployed and reachable. */
export async function checkJobsSearchRpcHealth(): Promise<'ok' | 'error' | 'skipped'> {
    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!supabaseUrl || !supabaseKey) {
        return 'skipped';
    }

    const probe = async (rpcName: string): Promise<boolean> => {
        try {
            const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
                method: 'POST',
                headers: {
                    apikey: supabaseKey,
                    Authorization: `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    p_role_query: '__health__',
                    p_where_query: null,
                    p_company_ids: null,
                    p_excluded_ids: null,
                    p_excluded_company_ids: null,
                    p_company_id: null,
                    p_offset: 0,
                    p_limit: 1,
                }),
                signal: AbortSignal.timeout(5000),
            });
            return response.ok;
        } catch {
            return false;
        }
    };

    // UK RPC is required; Ireland RPC is best-effort until migration is applied
    // (ProductBackend falls back to ilike on jobs_IR when missing).
    const ukOk = await probe(searchJobsPageRpc('uk'));
    if (!ukOk) return 'error';

    void probe('search_jobs_ir_page');
    return 'ok';
}
