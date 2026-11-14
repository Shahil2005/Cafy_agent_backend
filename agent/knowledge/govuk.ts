import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { INSTRUCTION } from '../../jobs-portal/careerMatchProfile';
import { textWindows } from '../cv/chunk';
import { cosine, embedTexts, type EmbedFn } from '../cv/embed';
import { packVector, unpackVector } from '../cv';
import { wordOverlapScorer } from '../cv';

/**
 * GOV.UK knowledge base: official pages (Open Government Licence v3), fetched by
 * scripts/agent/buildGovukKnowledge.ts through the GOV.UK Content API, chunked in full and
 * embedded with the free gte-small edge function. Stored as committed JSON shards; read only
 * when the visa_info tool needs them (no in-memory cache), never in a database.
 */

export const KNOWLEDGE_DIR = path.join(__dirname, 'govuk');
/** Older than this, a passage is flagged so the answer says it may be out of date. */
export const STALE_AFTER_DAYS = 45;

export interface KnowledgeChunk {
    section: string;
    text: string;
    /** base64 float32; empty when the embedding service was unavailable at build time. */
    vector: string;
}

export interface KnowledgePage {
    path: string;
    title: string;
    url: string;
    /** When GOV.UK last changed the page (public_updated_at). */
    updatedAt?: string;
    /** When our build last fetched it. */
    fetchedAt: string;
    contentHash: string;
    chunks: KnowledgeChunk[];
}

export interface KnowledgeShard {
    topic: string;
    builtAt: string;
    pages: KnowledgePage[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };

function decodeEntities(value: string): string {
    return value
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** GOV.UK body HTML → plain text with "## " heading markers and "- " list items. */
export function htmlToText(html: string): string {
    return decodeEntities(
        html
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<h[1-6][^>]*>/gi, '\n## ')
            .replace(/<\/h[1-6]>/gi, '\n')
            .replace(/<li[^>]*>/gi, '\n- ')
            .replace(/<(?:br|\/p|\/div|\/tr|\/table|\/ul|\/ol|\/section)\s*\/?>/gi, '\n')
            .replace(/<\/t[dh]>/gi, ' | ')
            .replace(/<[^>]+>/g, ' '),
    )
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        // Untrusted text: instruction-like lines are dropped, as for CVs and adverts.
        .filter((line) => line && !INSTRUCTION.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Splits page text by its "## " headings, then into size-based windows: every word is kept. */
export function chunkPage(text: string, pageTitle: string): Array<{ section: string; text: string }> {
    const out: Array<{ section: string; text: string }> = [];
    let section = pageTitle;
    let buffer: string[] = [];
    const flush = () => {
        const body = buffer.join('\n').trim();
        if (body) for (const piece of textWindows(body)) if (piece.trim()) out.push({ section, text: piece.trim() });
        buffer = [];
    };
    for (const line of text.split('\n')) {
        if (line.startsWith('## ')) {
            flush();
            section = line.slice(3).trim() || pageTitle;
        } else buffer.push(line);
    }
    flush();
    return out;
}

export function contentHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Reads every shard from disk for this request only. */
export function loadShards(dir = KNOWLEDGE_DIR): KnowledgeShard[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as KnowledgeShard);
}

export interface KnowledgeHit {
    topic: string;
    title: string;
    section: string;
    url: string;
    text: string;
    fetchedAt: string;
    updatedAt?: string;
    stale: boolean;
    score: number;
}

/** Top passages by meaning (cosine), falling back to shared-word scoring if embedding is unavailable. */
export async function searchKnowledge(
    query: string,
    options: { shards?: KnowledgeShard[]; embed?: EmbedFn; limit?: number; topics?: string[]; now?: number } = {},
): Promise<KnowledgeHit[]> {
    const shards = (options.shards ?? loadShards()).filter((s) => !options.topics?.length || options.topics.includes(s.topic));
    const vector = await (options.embed ?? embedTexts)([query.slice(0, 1000)]).then((v) => v[0]).catch(() => undefined);
    const words = wordOverlapScorer(query);
    const now = options.now ?? Date.now();
    const hits: KnowledgeHit[] = [];
    for (const shard of shards) {
        for (const page of shard.pages) {
            const stale = now - Date.parse(page.fetchedAt) > STALE_AFTER_DAYS * 86_400_000;
            for (const chunk of page.chunks) {
                const score = vector && chunk.vector ? cosine(vector, unpackVector(chunk.vector)) : words({ section: `${page.title} ${chunk.section}`, text: chunk.text });
                hits.push({ topic: shard.topic, title: page.title, section: chunk.section, url: page.url, text: chunk.text, fetchedAt: page.fetchedAt, updatedAt: page.updatedAt, stale, score });
            }
        }
    }
    hits.sort((a, b) => b.score - a.score);
    // At most two passages per page, so one long page cannot crowd out the rest.
    const perPage = new Map<string, number>();
    return hits
        .filter((h) => {
            const n = perPage.get(h.url) ?? 0;
            perPage.set(h.url, n + 1);
            return n < 2;
        })
        .slice(0, options.limit ?? 5);
}

const ASKS_PAY_RATE = /£|\bpounds?\b|\b(?:rates?|wages?|hourly)\b|\b(?:an|per) hour\b/i;
const OUT_OF_PERMISSION = /\b(?:overstay\w*|out of status|no (?:valid )?visa|visa (?:has )?(?:expired|run out)|illegally in the uk)\b/i;
const HELP_PAGES = [/^Find an immigration adviser/i, /^Get help to return home/i];
const SURCHARGE = /\b(?:health(?:care)? surcharge|ihs)\b/i;
const ASKS_COST = /\bhow much\b|\b(?:cost|costs|fees?|surcharge)\b/i;
const RATE_SECTION = /^current rates$/i;
const COST_SECTION = /^(?:how much it costs|fees|application fees?|cost|costs)$/i;
const HOURLY_PAY = /\b(?:an|per) hour\b|\bhourly\b/i;

/** "Is 8 pounds an hour legal" shares no meaning with the page that answers it, so it is looked up in GOV.UK's own words. */
const FULL_DATE = /\b(?:\d{1,2} )?(?:January|February|March|April|May|June|July|August|September|October|November|December) 20\d{2}\b/g;

/** Tags each full date as past or future, worked out by code, so a rule already in force is never told as a coming change. */
export function withDateStatus(text: string, now = Date.now()): string {
    return text.replace(FULL_DATE, (date) => `${date} [${Date.parse(`${/^\d/.test(date) ? '' : '1 '}${date} UTC`) <= now ? 'passed' : 'to come'}]`);
}

export function withoutDateStatus(text: string): string {
    return text.replace(/ ?\[(?:passed|to come)\]/g, '');
}

export function officialQuestion(question: string): string {
    if (HOURLY_PAY.test(question) && !/minimum wage|living wage/i.test(question)) return `National Minimum Wage rates: ${question}`;
    return SURCHARGE.test(question) ? `Pay for UK healthcare as part of your immigration application: ${question}` : question;
}

/**
 * A table of figures matches a question poorly by meaning, so "what is the minimum wage" finds the page but not its rates.
 * For a question about an amount, the found page's figures section comes along too, first, so a length limit cannot cut it.
 * Official text only, unchanged.
 */
export function withFigureSections(hits: KnowledgeHit[], question: string, shards: KnowledgeShard[], maxExtra = 2): KnowledgeHit[] {
    const wanted = (section: string) => (ASKS_PAY_RATE.test(question) && RATE_SECTION.test(section)) || (ASKS_COST.test(question) && COST_SECTION.test(section));
    const extra: KnowledgeHit[] = [];
    for (const url of new Set(hits.map((hit) => hit.url))) {
        if (extra.length >= maxExtra) break;
        const found = hits.find((hit) => hit.url === url)!;
        const page = shards.flatMap((shard) => shard.pages).find((candidate) => candidate.url === url);
        const chunk = page?.chunks.find((candidate) => wanted(candidate.section.trim()) && !hits.some((hit) => hit.url === url && hit.section === candidate.section));
        if (chunk) extra.push({ ...found, section: chunk.section, text: chunk.text });
    }
    // Someone whose permission has run out needs GOV.UK's own help pages, not only the rule, whatever the search found.
    if (OUT_OF_PERMISSION.test(question)) {
        for (const title of HELP_PAGES) {
            const page = shards.flatMap((shard) => shard.pages).find((candidate) => title.test(candidate.title));
            const chunk = page?.chunks[0];
            if (page && chunk && !hits.some((hit) => hit.url === page.url)) {
                extra.push({ topic: 'work-visas', title: page.title, section: chunk.section, url: page.url, text: chunk.text, fetchedAt: page.fetchedAt, stale: false, score: 1 });
            }
        }
    }
    // The surcharge is set on one page; other visa pages quote only their own case, such as £776 for Youth Mobility.
    if (SURCHARGE.test(question)) {
        const page = shards.flatMap((shard) => shard.pages).find((candidate) => /^Pay for UK healthcare/i.test(candidate.title));
        const chunk = page?.chunks.find((candidate) => /^cost\b/i.test(candidate.section.trim()));
        if (page && chunk && !hits.some((hit) => hit.url === page.url && hit.section === chunk.section)) {
            extra.unshift({ topic: 'work-visas', title: page.title, section: chunk.section, url: page.url, text: chunk.text, fetchedAt: page.fetchedAt, stale: false, score: 1 });
        }
    }
    return [...extra, ...hits];
}

export { packVector };
