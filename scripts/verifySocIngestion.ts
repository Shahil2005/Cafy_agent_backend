import '../env';
import { createClient } from '@supabase/supabase-js';
import { matchSocOccupations } from '../ai/careerAnalysis/vectorSearch';

/**
 * Read-only diagnostic for the "works locally, fails in production" SOC-match problem.
 * Run it with the SAME RESUME_SUPABASE_URL / RESUME_SUPABASE_SERVICE_ROLE_KEY / HF_TOKEN
 * that the target environment uses:
 *
 *   npx ts-node scripts/verifySocIngestion.ts
 *
 * It reports how many SOC rows exist, whether they carry embeddings, and what a canonical
 * DevOps resume actually matches against - with similarity scores. A healthy prod table
 * puts SOC 2139 / 2134 / 2133 near the top with similarity comfortably above the
 * CAREER_SOC_MIN_TOP_SIMILARITY floor.
 */

const DEVOPS_RESUME = `
DevOps Engineer. Technical Skills: AWS (EC2, IAM, RDS, VPC, S3, CloudWatch), Linux administration
(systemctl, journalctl), Docker, Jenkins, Git, Terraform, Kubernetes, Apache Kafka / Kafka Connect,
Prometheus, Grafana, CloudWatch monitoring, MySQL / PostgreSQL, Python automation, CI/CD pipelines,
infrastructure as code, YAML, Cron. 1+ year hands-on experience in AWS cloud operations, infrastructure
monitoring and production support in a FinTech environment.
`;

async function main() {
    const url = process.env.RESUME_SUPABASE_URL;
    const key = process.env.RESUME_SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing RESUME_SUPABASE_URL / RESUME_SUPABASE_SERVICE_ROLE_KEY');

    console.log(`Supabase project: ${url}`);
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

    const { count, error: countErr } = await supabase
        .from('uk_soc_occupations')
        .select('soc_code', { count: 'exact', head: true });
    if (countErr) throw new Error(`Count failed: ${countErr.message}`);
    console.log(`Rows in uk_soc_occupations: ${count}`);

    const { data: sample, error: sampleErr } = await supabase
        .from('uk_soc_occupations')
        .select('soc_code, title, embedding')
        .in('soc_code', ['2139', '2134', '5435'])
        .limit(3);
    if (sampleErr) throw new Error(`Sample failed: ${sampleErr.message}`);
    for (const row of sample ?? []) {
        const emb = (row as { embedding: unknown }).embedding;
        const dim = Array.isArray(emb)
            ? emb.length
            : typeof emb === 'string'
              ? `string(${(emb as string).length} chars)`
              : typeof emb;
        console.log(`  ${row.soc_code} | ${row.title} | embedding dim: ${dim}`);
    }

    console.log('\nMatching a canonical DevOps resume...\n');
    const matches = await matchSocOccupations(DEVOPS_RESUME, 10);
    for (const m of matches) {
        console.log(`  ${m.soc_code} | ${m.similarity.toFixed(4)} | ${m.title}`);
    }
    console.log('\nExpected near the top: 2139 (IT professionals nec / DevOps), 2134 (software dev), 2133 (architects).');
}

main().catch((err) => {
    console.error('\nVerification failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
