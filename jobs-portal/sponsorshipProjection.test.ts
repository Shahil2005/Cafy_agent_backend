import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSponsorshipAssessment } from './sponsorshipProjection';
import {
    portalJobChatColumns,
    toPublicPortalJob,
    toPublicPortalJobs,
} from './publicResponse';
import {
    isStrictUkSponsorshipFeed,
    jobsTableForCountry,
    jobsCatalogCacheSegment,
    searchJobsPageRpc,
} from './jobsCatalog';

const evidence = () => ({
    verdict: 'potential',
    assessedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    scenario: 'standard_skilled_worker',
    occupation: { code: '2134', title: 'Programmers', status: 'estimated' },
    licence: {
        organisation: 'Example Ltd',
        checkedAt: new Date().toISOString(),
        sourceUrl: 'https://www.gov.uk/register',
    },
    salary: { requiredAnnual: 54700 },
    salaryEvidence: { min: 55000, max: 60000 },
    hoursEvidence: { value: 37.5 },
    sponsorshipPolicy: 'unknown',
    sponsorshipEvidence: [],
    sources: [
        'https://www.gov.uk/rules',
        'javascript:alert(1)',
        'https://example.test/apply',
    ],
    secret: 'must not escape',
});
test('public evidence is explicitly projected and survives repeated public job conversion', () => {
    const projected = publicSponsorshipAssessment(evidence())!;
    assert.equal(projected.verdict, 'potential');
    assert.equal('secret' in projected, false);
    assert.deepEqual(projected.sources, ['https://www.gov.uk/rules']);
    const job = toPublicPortalJob({
        id: 1,
        title: 'Engineer',
        sponsorship_assessment: evidence(),
    });
    assert.deepEqual(
        toPublicPortalJobs([job])[0].sponsorshipAssessment,
        job.sponsorshipAssessment,
    );
});
test('expired or incomplete evidence cannot generate a public badge', () => {
    assert.equal(
        publicSponsorshipAssessment({ ...evidence(), expiresAt: '2020-01-01' }),
        undefined,
    );
    assert.equal(
        publicSponsorshipAssessment({
            ...evidence(),
            occupation: { code: 'invalid' },
        }),
        undefined,
    );
});
test('strict feed config routes UK search separately and isolates caches', () => {
    const previous = process.env.UK_SPONSORSHIP_FEED_MODE;
    try {
        process.env.UK_SPONSORSHIP_FEED_MODE = 'strict';
        assert.equal(isStrictUkSponsorshipFeed(), true);
        assert.equal(jobsTableForCountry('uk'), 'sponsorship_jobs');
        assert.equal(searchJobsPageRpc('uk'), 'search_sponsorship_jobs_page');
        assert.equal(searchJobsPageRpc('ireland'), 'search_jobs_ir_page');
        assert.equal(jobsCatalogCacheSegment('uk'), 'uk-sponsorship-v1');
        assert.equal(jobsCatalogCacheSegment('ireland'), 'ireland');
        assert.ok(
            portalJobChatColumns('sponsorship_jobs').includes(
                'sponsorship_assessment',
            ),
        );
        assert.ok(
            !portalJobChatColumns('jobs_IR').includes('sponsorship_assessment'),
        );
        process.env.UK_SPONSORSHIP_FEED_MODE = 'typo';
        assert.throws(() => isStrictUkSponsorshipFeed());
    } finally {
        if (previous === undefined) delete process.env.UK_SPONSORSHIP_FEED_MODE;
        else process.env.UK_SPONSORSHIP_FEED_MODE = previous;
    }
});
