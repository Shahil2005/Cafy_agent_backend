/**
 * Quality check for the faster job ranking trial (supabase/testing/agent_match_jobs_fast.sql).
 * Runs the same searches through the exact ranking and the trial, and shows whether the jobs users see are the same.
 * Reads only, on the TESTING database only. Each search rests 20s, because the free plan's disk budget is small.
 *
 *   AGENT_RANK_REPLAY_DIR=<folder> npx ts-node --transpile-only scripts/agent/compareFastRank.ts [--shortlist=500] [--only=role|filter|cv]
 *
 * Pass: for every search, the same top 3 jobs (in any order) and at least 9 of the top 10.
 */
import 'dotenv/config';
import './rankReplay';
import { indexCv, type CvIndex } from '../../agent/cv';
import { EVAL_CV } from '../../agent/eval/cases';
import { memoryStores } from '../../agent/testStores';
import { createJobTools } from '../../agent/tools/jobs';

const SHORTLIST = Number(process.argv.find((a) => a.startsWith('--shortlist='))?.slice(12)) || 500;
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const REST_MS = 20_000;
const url = process.env.SUPABASE_URL?.trim() ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
if (!url.includes('icsoljtmqwqibwpqhwyf')) throw new Error('STOP: this check runs on the testing database only.');

const ROLES = ['chef', 'registered nurse', 'accountant', 'primary teacher', 'welder', 'marketing', 'software engineer', 'data analyst', 'care worker', 'hgv driver', 'solicitor', 'electrician'];
const FILTERED: Array<[string, Record<string, unknown>]> = [
    ['part time jobs in leeds', { location: 'Leeds', jobTypes: ['part-time'] }],
    ['nursing jobs in manchester', { role: 'nursing', location: 'Manchester' }],
    ['remote data jobs', { role: 'data', remote: true }],
    ['engineering jobs over 50000', { role: 'engineering', minPay: 50000 }],
];
const CVS: Record<string, string> = {
    nurse: 'Amina Yusuf\nRegistered Nurse, NMC registered.\nExperience\nStaff Nurse, Leeds Teaching Hospitals, 2019-01 to present. Acute medical ward, medication rounds, wound care, patient assessment.\nHealthcare Assistant, Bupa, 2016-06 to 2018-12. Personal care for elderly residents.\nEducation\nBSc Adult Nursing, University of Leeds, 2018.',
    chef: 'Marco Bianchi\nSous Chef.\nExperience\nSous Chef, The Ivy, London, 2020-03 to present. Menu planning, kitchen team of eight, food safety, stock control.\nChef de Partie, Hilton, 2016-01 to 2020-02.\nEducation\nLevel 3 Diploma in Professional Cookery. Food Hygiene Level 3.',
    care: 'Grace Okafor\nCare Worker.\nExperience\nSenior Care Assistant, Sunrise Care Home, 2021-02 to present. Personal care, medication support, care plans, dementia care.\nDomiciliary Carer, Allied Healthcare, 2018-05 to 2021-01.\nEducation\nNVQ Level 3 Health and Social Care.',
    driver: 'Tomasz Nowak\nHGV Class 1 Driver.\nExperience\nHGV Driver, Eddie Stobart, 2015-04 to present. Long-distance deliveries, tachograph records, load security.\nVan Driver, DPD, 2011-01 to 2015-03.\nLicences: Cat C+E, Driver CPC, ADR.',
};

interface Comparison { name: string; exact: number[]; fast: number[]; fastSeconds: number }
const compared: Comparison[] = [];
let current = '';

/** Runs the agent's own search unchanged; each ranking it asks for also goes to the trial, using the very same request. */
const replayingFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = String(input instanceof Request ? input.url : input);
    if (!target.endsWith('/rest/v1/rpc/agent_match_jobs') || typeof init?.body !== 'string') return replayingFetch(input, init);
    const exact = await replayingFetch(input, init);
    if (!exact.ok) return exact;
    const started = Date.now();
    const trial = await replayingFetch(`${url}/rest/v1/rpc/agent_match_jobs_fast`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(init.body), p_shortlist: SHORTLIST }),
    });
    if (!trial.ok) throw new Error(`Trial ranking failed: HTTP ${trial.status}`);
    const ids = (rows: Array<{ job_id: number }>) => rows.slice(0, 10).map((row) => Number(row.job_id));
    compared.push({ name: current, exact: ids((await exact.clone().json()) as Array<{ job_id: number }>), fast: ids((await trial.json()) as Array<{ job_id: number }>), fastSeconds: (Date.now() - started) / 1000 });
    return exact;
}) as typeof fetch;

const shared = (a: number[], b: number[]) => a.filter((id) => b.includes(id)).length;

async function compare(name: string, args: Record<string, unknown>, message: string, cv: CvIndex | null): Promise<void> {
    const search = createJobTools().find((tool) => tool.name === 'search_jobs')!;
    current = name;
    const before = compared.length;
    const out = (await search.run(args as never, { uid: 'compare', signal: new AbortController().signal, cv, emit: () => {}, showCvCard: false, userMessage: message } as never)) as { error?: string };
    if (compared.length === before) {
        console.log(`SKIPPED ${name}: ${out?.error ?? 'no ranking was made'}`);
    } else {
        const row = compared[compared.length - 1]!;
        console.log(`${name}: top 10 shared ${shared(row.exact, row.fast)}/${row.exact.length}, top 3 shared ${shared(row.exact.slice(0, 3), row.fast.slice(0, 3))}/${Math.min(3, row.exact.length)}, trial ${row.fastSeconds.toFixed(1)}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, REST_MS));
}

async function main(): Promise<void> {
    if (!ONLY || ONLY === 'role') for (const role of ROLES) await compare(role, { role }, `${role} jobs`, null);
    if (!ONLY || ONLY === 'filter') for (const [message, args] of FILTERED) await compare(message, args, message, null);
    if (!ONLY || ONLY === 'cv') {
        const texts: Record<string, { name: string; text: string }> = { eval: EVAL_CV, ...Object.fromEntries(Object.entries(CVS).map(([name, text]) => [name, { name: `${name}.pdf`, text }])) };
        for (const [name, file] of Object.entries(texts)) {
            const indexed = await indexCv('compare', file, { signal: AbortSignal.timeout(90_000), store: memoryStores().cvStore });
            await compare(`CV ${name}`, {}, 'jobs for my cv', indexed.index);
        }
    }
    const passed = compared.filter((row) => shared(row.exact.slice(0, 3), row.fast.slice(0, 3)) === Math.min(3, row.exact.length) && shared(row.exact, row.fast) >= Math.min(9, row.exact.length));
    const seconds = compared.map((row) => row.fastSeconds).sort((a, b) => a - b);
    console.log(`\nShortlist ${SHORTLIST}: ${passed.length} of ${compared.length} searches match. Trial time: middle ${seconds[Math.floor(seconds.length / 2)]?.toFixed(1)}s, slowest ${seconds[seconds.length - 1]?.toFixed(1)}s.`);
    console.log(passed.length === compared.length && compared.length ? 'RESULT: PASS' : 'RESULT: NOT GOOD ENOUGH, or searches were skipped. Keep the exact ranking.');
}

main().then(() => process.exit(0), (error: Error) => { console.error(error.message); process.exit(1); });
