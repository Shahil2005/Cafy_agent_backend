import { createClient } from '@supabase/supabase-js';
import { createChatCatalogueReadOnlyFetch } from '../../jobs-portal/chatCatalogue';

/**
 * Where the chat agent reads jobs, companies and pay from.
 *
 * - AGENT_JOBS_SUPABASE_URL + AGENT_JOBS_SUPABASE_SERVICE_ROLE_KEY set: the agent reads THAT project (the live
 *   CAFY database) and only reads. The job ranking runs in this backend (readOnlyRank.ts), because the
 *   ranking function and job vectors exist only in the testing copy, and nothing is ever written or created there.
 * - Not set: the agent uses SUPABASE_URL (the testing copy) with its database ranking function, as before.
 *
 * The rest of the backend (jobs portal, job reports, directory sync) always uses SUPABASE_URL, so nothing it
 * writes can reach the database the agent reads.
 */
export interface AgentJobsDb {
    url: string;
    key: string;
    /** Every request is a GET or HEAD, and the ranking is worked out here instead of by a database function. */
    readOnly: boolean;
}

/** The live CAFY project. Whatever the settings say, the agent never writes to it or calls functions on it. */
export const LIVE_PROJECT_REF = 'lfwncmziiwgbswjmrktl';

export function agentJobsDb(env: NodeJS.ProcessEnv = process.env): AgentJobsDb | null {
    const ownUrl = env.AGENT_JOBS_SUPABASE_URL?.trim();
    const ownKey = env.AGENT_JOBS_SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (ownUrl && ownKey) return { url: ownUrl, key: ownKey, readOnly: true };
    const url = env.SUPABASE_URL?.trim();
    const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!url || !key) return null;
    return { url, key, readOnly: url.includes(LIVE_PROJECT_REF) };
}

/** A Supabase client that can only SELECT (any other request throws before it is sent). */
export function agentJobsClient(signal: AbortSignal, profile?: 'career-matching') {
    const db = agentJobsDb();
    if (!db) throw new Error('Jobs database is not configured');
    return createClient(db.url, db.key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: createChatCatalogueReadOnlyFetch({ signal, ...(profile ? { profile } : {}) }) },
    });
}
