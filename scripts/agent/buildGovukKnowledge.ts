/**
 * Builds the chat agent's GOV.UK knowledge base: agent/knowledge/govuk/<topic>.json.
 *
 *   npx ts-node --transpile-only scripts/agent/buildGovukKnowledge.ts            (build / update)
 *   npx ts-node --transpile-only scripts/agent/buildGovukKnowledge.ts --dry-run  (crawl only, write nothing)
 *
 * - Source: the official GOV.UK Content API (https://www.gov.uk/api/content/<path>), Open Government
 *   Licence v3. Pages are attributed "Source: GOV.UK" with their link.
 * - Coverage: everything under the career-relevant GOV.UK topic pages (all children and sub-topics),
 *   plus listed guidance pages, every part of each guide and every HTML attachment of publications.
 * - Every page is chunked in full; vectors come from the free gte-small edge function (embedOnly).
 * - Incremental: unchanged pages (same content hash) keep their vectors, so re-runs are quick.
 * - Writes only these local files. No database is touched.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { embedTexts } from '../../agent/cv/embed';
import {
    chunkPage,
    contentHash,
    htmlToText,
    KNOWLEDGE_DIR,
    loadShards,
    packVector,
    type KnowledgePage,
    type KnowledgeShard,
} from '../../agent/knowledge/govuk';

const API = 'https://www.gov.uk/api/content';
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_PAGES = 700;
const CONCURRENCY = 4;

/** Topic → seed paths. Browse pages are expanded to all their child pages and sub-topics. */
const TOPICS: Record<string, { browse: string[]; pages: string[] }> = {
    'work-visas': {
        browse: ['/browse/visas-immigration/work-visas', '/browse/visas-immigration/student-visas', '/browse/visas-immigration/what-you-need-to-do', '/browse/visas-immigration/settle-in-the-uk'],
        pages: [
            '/skilled-worker-visa',
            '/graduate-visa',
            '/student-visa',
            '/health-care-worker-visa',
            '/uk-visa-sponsorship-employers',
            '/government/publications/skilled-worker-visa-going-rates-for-eligible-occupations',
            '/government/publications/skilled-worker-visa-immigration-salary-list',
            '/government/publications/skilled-worker-visa-temporary-shortage-list',
            '/guidance/immigration-rules/immigration-rules-appendix-skilled-worker',
            '/guidance/immigration-rules/immigration-rules-appendix-skilled-occupations',
            '/guidance/immigration-rules/immigration-rules-appendix-graduate',
            '/government/collections/sponsorship-information-for-employers-and-educators',
            // Overstaying: the rule itself, the way home and where to get regulated advice.
            '/guidance/immigration-rules/immigration-rules-part-suitability',
            '/return-home-voluntarily',
            '/find-an-immigration-adviser',
        ],
    },
    'work-rights': {
        browse: [
            '/browse/working/contract-working-hours',
            '/browse/working/time-off',
            '/browse/working/redundancies-dismissals',
            '/browse/working/rights-trade-unions',
            '/browse/working/finding-job',
            '/browse/working/workplace-personal-safety',
            '/browse/employing-people/recruiting-hiring',
        ],
        pages: ['/national-minimum-wage-rates', '/holiday-entitlement-rights', '/statutory-sick-pay', '/discrimination-your-rights', '/working-when-pregnant-your-rights', '/check-job-applicant-right-to-work', '/prove-right-to-work'],
    },
    'starting-work': {
        browse: ['/browse/working/tax-national-insurance', '/browse/education/student-finance'],
        pages: ['/apply-national-insurance-number', '/tax-codes', '/paye-forms-p45-p60-p11d', '/repaying-your-student-loan', '/become-apprentice', '/apprenticeships-guide'],
    },
};

interface ApiItem {
    base_path?: string;
    title?: string;
    schema_name?: string;
    document_type?: string;
    public_updated_at?: string;
    details?: Record<string, unknown>;
    links?: Record<string, Array<{ base_path?: string; document_type?: string; schema_name?: string }>>;
}

async function fetchItem(basePath: string): Promise<ApiItem | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(`${API}${basePath}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
            if (res.status === 404 || res.status === 410) return null;
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return null;
            return (await res.json()) as ApiItem;
        } catch (error) {
            if (attempt === 3) {
                console.warn(`[govuk] failed ${basePath}: ${(error as Error).message}`);
                return null;
            }
            await new Promise((r) => setTimeout(r, 800 * attempt));
        }
    }
    return null;
}

function bodyHtml(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const html = value.find((v) => (v as { content_type?: string }).content_type === 'text/html') as { content?: string } | undefined;
        return html?.content ?? '';
    }
    return '';
}

/** Page text from any GOV.UK schema: guides (all parts), guidance/answers (body), transactions, manuals. */
function extract(item: ApiItem): { text: string; follow: string[] } {
    const d = item.details ?? {};
    const follow: string[] = [];
    let html = '';
    const parts = d.parts as Array<{ title?: string; slug?: string; body?: unknown }> | undefined;
    if (Array.isArray(parts)) html = parts.map((p) => `<h2>${p.title ?? ''}</h2>${bodyHtml(p.body)}`).join('\n');
    else html = [d.introductory_paragraph, d.introduction, d.body, d.more_information, d.other_ways_to_apply, d.what_you_need_to_know, d.start_button_text ? '' : '']
        .map(bodyHtml)
        .filter(Boolean)
        .join('\n');
    // Publications link their HTML attachments; collections list their documents.
    for (const a of (d.attachments as Array<{ url?: string; attachment_type?: string }> | undefined) ?? []) {
        if (a.attachment_type === 'html' && a.url?.startsWith('https://www.gov.uk/')) follow.push(a.url.replace('https://www.gov.uk', ''));
    }
    for (const doc of item.links?.documents ?? []) if (doc.base_path) follow.push(doc.base_path);
    for (const child of item.links?.children ?? []) if (child.base_path) follow.push(child.base_path);
    return { text: htmlToText(html), follow };
}

async function crawl(topic: string, seeds: { browse: string[]; pages: string[] }): Promise<Map<string, ApiItem>> {
    const pages = new Map<string, ApiItem>();
    const seen = new Set<string>();
    const queue: string[] = [];
    const visitBrowse = async (browsePath: string, depth: number) => {
        if (seen.has(browsePath) || depth > 2) return;
        seen.add(browsePath);
        const item = await fetchItem(browsePath);
        if (!item) return;
        for (const child of item.links?.children ?? []) if (child.base_path) queue.push(child.base_path);
        // Sub-topics of the same section only (e.g. /browse/working/... stays inside /browse/working).
        const section = browsePath.split('/').slice(0, 3).join('/');
        for (const sub of item.links?.second_level_browse_pages ?? [])
            if (sub.base_path?.startsWith(section) && seeds.browse.includes(sub.base_path)) await visitBrowse(sub.base_path, depth + 1);
    };
    for (const b of seeds.browse) await visitBrowse(b, 0);
    queue.push(...seeds.pages);
    while (queue.length && pages.size < MAX_PAGES) {
        const batch = queue.splice(0, CONCURRENCY).filter((p) => !seen.has(p) && (seen.add(p), true));
        const items = await Promise.all(batch.map(async (p) => [p, await fetchItem(p)] as const));
        for (const [p, item] of items) {
            if (!item || item.schema_name === 'mainstream_browse_page' || item.schema_name === 'redirect') continue;
            const { follow } = extract(item);
            pages.set(p, item);
            for (const f of follow) if (!seen.has(f)) queue.push(f);
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    console.log(`[govuk] ${topic}: ${pages.size} pages`);
    return pages;
}

async function main() {
    const previous = new Map(loadShards().flatMap((s) => s.pages.map((p) => [p.path, p] as const)));
    const builtAt = new Date().toISOString();
    if (!DRY_RUN) mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    const assigned = new Set<string>();
    for (const [topic, seeds] of Object.entries(TOPICS)) {
        const items = await crawl(topic, seeds);
        const out: KnowledgePage[] = [];
        let reused = 0;
        let embedded = 0;
        for (const [p, item] of items) {
            if (assigned.has(p)) continue; // each page lives in one shard
            assigned.add(p);
            const title = item.title ?? p;
            const { text } = extract(item);
            if (text.length < 80) continue;
            const hash = contentHash(text);
            const old = previous.get(p);
            if (old && old.contentHash === hash && old.chunks.every((c) => c.vector)) {
                out.push({ ...old, title, updatedAt: item.public_updated_at, fetchedAt: builtAt });
                reused++;
                continue;
            }
            const pieces = chunkPage(text, title);
            let vectors: number[][] = [];
            if (!DRY_RUN && pieces.length) {
                vectors = await embedTexts(pieces.map((c) => `${c.section.slice(0, 80)}: ${c.text}`)).catch((e) => {
                    console.warn(`[govuk] embedding failed for ${p}: ${(e as Error).message}`);
                    return [];
                });
            }
            embedded++;
            out.push({
                path: p,
                title,
                url: `https://www.gov.uk${p}`,
                ...(item.public_updated_at ? { updatedAt: item.public_updated_at } : {}),
                fetchedAt: builtAt,
                contentHash: hash,
                chunks: pieces.map((c, i) => ({ ...c, vector: vectors[i] ? packVector(vectors[i]!) : '' })),
            });
        }
        const chunks = out.reduce((n, p) => n + p.chunks.length, 0);
        console.log(`[govuk] ${topic}: ${out.length} pages kept, ${chunks} pieces, ${reused} unchanged, ${embedded} (re)embedded`);
        if (!DRY_RUN) {
            const shard: KnowledgeShard = { topic, builtAt, pages: out.sort((a, b) => a.path.localeCompare(b.path)) };
            writeFileSync(path.join(KNOWLEDGE_DIR, `${topic}.json`), JSON.stringify(shard));
        }
    }
}

main().catch((error) => {
    console.error('[govuk] build failed:', (error as Error).message);
    process.exit(1);
});
