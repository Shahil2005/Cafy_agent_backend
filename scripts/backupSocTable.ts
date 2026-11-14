import '../env';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

/**
 * Full, exact snapshot of uk_soc_occupations (embeddings included) to a local JSON file
 * BEFORE re-ingesting. Restore with: npx ts-node scripts/restoreSocTable.ts <file>
 * Read-only against the database.
 */
async function main() {
    const url = process.env.RESUME_SUPABASE_URL;
    const key = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing RESUME_SUPABASE_URL / RESUME_SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

    const pageSize = 500;
    let from = 0;
    const rows: unknown[] = [];
    for (;;) {
        const { data, error } = await supabase
            .from('uk_soc_occupations')
            .select('*')
            .order('soc_code', { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw new Error(`Backup read failed: ${error.message}`);
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }

    const dir = path.join(__dirname, '..', 'data', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outfile = path.join(dir, `uk_soc_occupations.${stamp}.json`);
    fs.writeFileSync(
        outfile,
        JSON.stringify({ project: url, takenAt: new Date().toISOString(), count: rows.length, rows }, null, 0)
    );

    console.log(`Backed up ${rows.length} rows to ${outfile}`);
    const withEmbedding = rows.filter((r) => (r as { embedding: unknown }).embedding != null).length;
    console.log(`Rows with a non-null embedding: ${withEmbedding}/${rows.length}`);
}

main().catch((err) => {
    console.error('Backup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
