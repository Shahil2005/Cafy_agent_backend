import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    IRELAND_PERMIT_RANGES,
    isIrelandSummaryEmployerName,
    matchesAnyPermitRange,
    queryIrelandSponsorshipData,
    volumePermitCount,
    type IrelandVolumeEmployer,
} from './irelandSponsorship';

describe('isIrelandSummaryEmployerName', () => {
    it('rejects DETE aggregate rows', () => {
        assert.equal(isIrelandSummaryEmployerName('Total'), true);
        assert.equal(isIrelandSummaryEmployerName('Grand Total'), true);
        assert.equal(isIrelandSummaryEmployerName('  TOTAL  '), true);
    });

    it('keeps real employers whose name starts with Total', () => {
        assert.equal(isIrelandSummaryEmployerName('Total Highway Maintenance Limited'), false);
        assert.equal(isIrelandSummaryEmployerName('Google Ireland Limited'), false);
    });
});

function employer(partial: {
    total: number;
    byYear: Partial<IrelandVolumeEmployer['permitsByYear']>;
}): IrelandVolumeEmployer {
    return {
        totalPermits: partial.total,
        permitsByYear: {
            '2020': 0,
            '2021': 0,
            '2022': 0,
            '2023': 0,
            '2024': 0,
            '2025': 0,
            '2026': 0,
            ...partial.byYear,
        },
    };
}

describe('volumePermitCount', () => {
    const sample = employer({ total: 500, byYear: { '2026': 56, '2025': 100 } });

    it('uses lifetime total when no years selected', () => {
        assert.equal(volumePermitCount(sample, null), 500);
        assert.equal(volumePermitCount(sample, []), 500);
    });

    it('sums only selected years when years are set', () => {
        assert.equal(volumePermitCount(sample, ['2026']), 56);
        assert.equal(volumePermitCount(sample, ['2025', '2026']), 156);
    });
});

describe('matchesAnyPermitRange', () => {
    const hundredPlus = IRELAND_PERMIT_RANGES.filter((r) => r.id === '100+');

    it('matches 100+ on lifetime volume but not on low single-year volume', () => {
        const sample = employer({ total: 1058, byYear: { '2026': 69 } });
        assert.equal(matchesAnyPermitRange(volumePermitCount(sample, null), hundredPlus), true);
        assert.equal(matchesAnyPermitRange(volumePermitCount(sample, ['2026']), hundredPlus), false);
    });

    it('matches 100+ when selected year itself is 100+', () => {
        const sample = employer({ total: 2599, byYear: { '2026': 158 } });
        assert.equal(matchesAnyPermitRange(volumePermitCount(sample, ['2026']), hundredPlus), true);
    });
});

describe('queryIrelandSponsorshipData integration', () => {
    it('scopes 100+ + 2026 to employers with >=101 permits in 2026', async () => {
        const range = IRELAND_PERMIT_RANGES.filter((r) => r.id === '100+');
        const result = await queryIrelandSponsorshipData(1, undefined, undefined, ['2026'], range);

        assert.equal(result.stats.volumeScopedToYears, true);
        assert.ok(result.totalCount > 0);
        assert.ok(result.totalCount < 50, `expected small set, got ${result.totalCount}`);

        for (const company of result.companies) {
            assert.ok(
                company.permitsByYear['2026'] >= 101,
                `${company.employerName} has ${company.permitsByYear['2026']} in 2026`
            );
        }

        const hundredPlusFacet = result.stats.permitRangeCounts.find((r) => r.id === '100+');
        assert.ok(hundredPlusFacet);
        assert.equal(hundredPlusFacet!.count, result.totalCount);
    });

    it('keeps lifetime volume when only 100+ is selected', async () => {
        const range = IRELAND_PERMIT_RANGES.filter((r) => r.id === '100+');
        const lifetime = await queryIrelandSponsorshipData(1, undefined, undefined, undefined, range);
        const scoped = await queryIrelandSponsorshipData(1, undefined, undefined, ['2026'], range);

        assert.equal(lifetime.stats.volumeScopedToYears, false);
        assert.ok(lifetime.totalCount > scoped.totalCount);
        assert.ok(lifetime.totalCount > 100);
    });
});
