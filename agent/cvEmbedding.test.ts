import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkCv, fitToModel } from './cv/chunk';
import { countEmbedTokens, MAX_EMBED_TOKENS } from './cv/tokens';
import { indexCv, CV_INDEX_VERSION, type CvIndex } from './cv';
import { cvQueryVectors } from './jobs/search';
import { memoryStores } from './testStores';

test('token counts match the gte-small tokenizer exactly', () => {
    // Expected values come from the real tokenizer (Supabase/gte-small via @huggingface/transformers).
    assert.equal(countEmbedTokens('Built weekly sales dashboards in Tableau.'), 11);
    assert.equal(countEmbedTokens('C#, .NET 8, K8s (AKS), p95 820ms -> 140ms (-83%), £1.4M/yr'), 39);
    assert.equal(countEmbedTokens('Café résumé 数据分析师 🚀'), 10);
    assert.equal(countEmbedTokens(''), 2);
});

const TECH_CV = `TECHNICAL SKILLS
${'C#, .NET 8, ASP.NET Core, EF Core, T-SQL, SSIS, Azure DevOps, CI/CD, K8s (AKS), Docker, gRPC, OAuth2/OIDC, JWT, xUnit, Redis, Kafka, Terraform (HCL), PowerShell 7, Python 3.11 (pandas/NumPy), TypeScript 5, React 18, PostgreSQL 16, '.repeat(8)}
EXPERIENCE
Senior Engineer, Contoso Ltd, 01/2021 - 06/2025
${'- Cut p95 latency 820ms -> 140ms (-83%) on 12 svc; 99.95% SLO; 3.2M req/day; £1.4M/yr saved; MTTR 4h -> 25m.\n'.repeat(14)}`;

test('every CV piece fits the model window, even dense skill lists and figures', () => {
    const pieces = chunkCv(TECH_CV);
    for (const piece of pieces) assert.ok(countEmbedTokens(`${piece.section}: ${piece.text}`) <= MAX_EMBED_TOKENS, `${piece.section} piece is ${countEmbedTokens(`${piece.section}: ${piece.text}`)} tokens`);
    assert.deepEqual(pieces.map((p) => p.index), pieces.map((_, i) => i), 'indexes stay in order');
});

test('re-cutting never loses a word', () => {
    const pieces = chunkCv(TECH_CV);
    const covered = pieces.map((p) => p.text).join(' ');
    const words = new Set(TECH_CV.replace(/TECHNICAL SKILLS|EXPERIENCE/g, ' ').split(/\s+/).filter(Boolean));
    for (const word of words) assert.ok(covered.includes(word), `"${word}" is in no piece`);
});

test('ordinary text is not cut further', () => {
    const prose = 'Built weekly sales dashboards in Tableau used by 40 store managers. '.repeat(15);
    assert.deepEqual(fitToModel('Experience', prose), [prose]);
});

const piece = (index: number, section: string, text: string, v: number[]) => ({ index, section, text, embedding: v });

test('contact-only pieces are not part of the CV query', () => {
    const query = cvQueryVectors({
        chunks: [
            piece(0, 'Top of CV', '[contact removed] | [contact removed] | Manchester', [1, 0]),
            piece(1, 'Experience', 'Data Analyst at Brightmart building Tableau dashboards and SQL forecasts', [0, 1]),
        ],
    });
    assert.deepEqual(query, [{ v: [0, 1], w: 1 }]);
});

test('a long CV keeps every piece: sections are averaged, with their weight', () => {
    const chunks = Array.from({ length: 30 }, (_, i) =>
        piece(i, i < 20 ? 'Experience' : i < 28 ? 'Publications' : 'Skills', `Piece number ${i} about data analysis work and results`, i < 20 ? [1, 0] : i < 28 ? [0, 1] : [0.6, 0.8]),
    );
    const query = cvQueryVectors({ chunks });
    assert.equal(query.length, 3, 'one vector per section');
    assert.deepEqual(query.map((q) => q.w), [20, 8, 2], 'weights add up to all 30 pieces');
    assert.deepEqual(query[0]!.v, [1, 0]);
    assert.ok(Math.abs(Math.hypot(...query[2]!.v) - 1) < 1e-9, 'averaged vectors are normalised');
});

test('a CV saved before exact token cutting is re-cut and re-embedded, keeping its profile (no AI call)', async () => {
    const { cvStore } = memoryStores();
    let extracted = 0;
    let embedded = 0;
    const options = {
        signal: new AbortController().signal,
        store: cvStore,
        extract: async () => { extracted++; return { profile: { headline: 'x', roles: [], education: [], skills: [], projects: [], achievements: [], certifications: [], languages: [], hasPersonalStatement: false }, calls: [] } as never; },
        embed: async (texts: string[]) => { embedded += texts.length; return texts.map(() => [0.6, 0.8]); },
    };
    const first = await indexCv('u1', { name: 'cv.pdf', text: TECH_CV }, options);
    assert.equal(extracted, 1);
    // Pretend it was saved by the previous version, with one long piece.
    const old: CvIndex = { ...first.index, version: 4, chunks: [piece(0, 'Technical skills', TECH_CV, [1, 0])] };
    await cvStore.put('u1', old);
    embedded = 0;
    const again = await indexCv('u1', { name: 'cv.pdf', text: TECH_CV }, options);
    assert.equal(extracted, 1, 'the profile is kept: no second AI read');
    assert.equal(again.index.version, CV_INDEX_VERSION);
    assert.ok(again.index.chunks.length > 1 && embedded === again.index.chunks.length, 'pieces re-cut and embedded');
    assert.equal((await cvStore.get('u1', again.index.hash))?.version, CV_INDEX_VERSION, 'saved, so it happens once');
});
