/**
 * Lightweight assertions for hybrid sector PostgREST clause builders.
 * Run: npx tsx jobs-portal/sectorPreferences.hybrid.test.ts
 */
import assert from 'node:assert/strict';
import {
    buildHybridSectorEmbeddingGapExcludeOr,
    buildHybridSectorMatchOr,
    buildNullSectorHybridExcludeOr,
    buildSectorEmbeddingGapFillAnd,
    buildStrictSectorMatchIn,
    quoteSectorsForPostgrest,
} from './sectorPreferences';

const sectors = ['Pharmaceutical', 'Data'] as const;
const list = quoteSectorsForPostgrest(sectors);

const matchOr = buildHybridSectorMatchOr(sectors);
assert.ok(matchOr.includes(`sector.in.(${list})`));
assert.ok(matchOr.includes(`sector_embedding.in.(${list})`));
assert.ok(matchOr.includes('sector.eq.Other'));
assert.ok(matchOr.includes('sector.is.null'));

assert.equal(buildStrictSectorMatchIn(sectors), `sector.in.(${list})`);
assert.ok(buildSectorEmbeddingGapFillAnd(sectors).includes(`sector_embedding.in.(${list})`));

const gapExclude = buildHybridSectorEmbeddingGapExcludeOr(sectors);
assert.ok(gapExclude.includes('sector.neq.Other'));
assert.ok(gapExclude.includes(`sector_embedding.not.in.(${list})`));

const nullExclude = buildNullSectorHybridExcludeOr(sectors);
assert.equal(
    nullExclude,
    `sector_embedding.is.null,sector_embedding.not.in.(${list})`
);

console.log('sectorPreferences.hybrid.test.ts: ok');
