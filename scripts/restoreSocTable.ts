import '../env';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

/**
 * Restore uk_soc_occupations from a backup file produced by scripts/backupSocTable.ts.
 * Usage: npx ts-node scripts/restoreSocTable.ts data/backups/uk_soc_occupations.<stamp>.json
 * Upserts every saved row verbatim (onConflict: soc_code), reverting the embeddings.
 */
async function main() {
    const file = process.argv[2];
    if (!file) throw new Error('Pass the backup file path as the first argument');

    const url = process.env.RESUME_SUPABASE_URL;
    const key = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing RESUME_SUPABASE_URL / RESUME_SUPABASE_SERVICE_ROLE_KEY');

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows: Record<string, unknown>[] };
    const rows = parsed.rows || [];
    if (rows.length === 0) throw new Error('Backup file has no rows');

    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

    const batchSize = 100;
    let done = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
        const slice = rows.slice(i, i + batchSize);
        const { error } = await supabase.from('uk_soc_occupations').upsert(slice, { onConflict: 'soc_code' });
        if (error) throw new Error(`Restore upsert failed at row ${i}: ${error.message}`);
        done += slice.length;
        console.log(`Restored ${done}/${rows.length}`);
    }
    console.log('Restore complete.');
}

main().catch((err) => {
    console.error('Restore failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
