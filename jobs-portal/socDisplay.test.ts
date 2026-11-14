import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toPublicPortalJob } from './publicResponse';
import { jobsTableSocDisplay } from './socDisplay';

describe('jobsTableSocDisplay', () => {
    it('shows one code when confidence is high and leaves alternatives out of the view', () => {
        const view = jobsTableSocDisplay({
            soc_code: '2134',
            soc_title: 'Programmers and software development professionals',
            soc_confidence: 'high',
            soc_alternatives: [
                { code: '2134', title: 'Programmers', share: 0.7 },
                { code: '2133', title: 'IT analysts', share: 0.2 },
            ],
        });
        assert.deepEqual(view, {
            kind: 'single',
            code: '2134',
            title: 'Programmers and software development professionals',
            reason: '',
        });
    });

    it('shows low-confidence codes at 40 percent or more, and drops the weaker ones', () => {
        const view = jobsTableSocDisplay({
            soc_code: '3556',
            soc_title: 'Sales accounts and business development managers',
            soc_confidence: 'low',
            soc_alternatives: [
                { code: '3556', title: 'Sales accounts and business development managers', share: 0.62 },
                { code: '1136', title: 'Information technology directors', share: 0.184 },
                { code: '2431', title: 'Management consultants and business analysts', share: 0.07 },
                { code: '2422', title: 'Finance and investment analysts and advisers', share: 0.05 },
            ],
        });
        assert.deepEqual(view, {
            kind: 'candidates',
            matches: [
                { code: '3556', title: 'Sales accounts and business development managers', percent: 62 },
            ],
            reason: '',
        });
    });

    it('lists the strongest code first when a weaker code is stored first', () => {
        const view = jobsTableSocDisplay({
            soc_confidence: 'low',
            soc_alternatives: [
                { code: '2135', title: 'Cyber security professionals', share: 0.48 },
                { code: '3319', title: 'Protective service associate professionals', share: 0.52 },
            ],
        });
        assert.deepEqual(
            view?.kind === 'candidates' ? view.matches.map((match) => match.code) : [],
            ['3319', '2135'],
        );
    });

    it('keeps a single best guess when every alternative is under 40 percent', () => {
        const view = jobsTableSocDisplay({
            soc_code: '2134',
            soc_confidence: 'low',
            soc_alternatives: [
                { code: '2133', title: 'IT analysts', share: 0.05 },
                { code: '2134', title: 'Programmers', share: 0.08 },
            ],
        });
        assert.deepEqual(view, {
            kind: 'candidates',
            matches: [{ code: '2134', title: 'Programmers', percent: 8 }],
            reason: '',
        });
    });

    it('keeps the SOC view when a job row is mapped a second time', () => {
        const once = toPublicPortalJob({
            id: 1,
            title: 'Principal Platform Engineer',
            soc_code: '2134',
            soc_title: 'Programmers and software development professionals',
            soc_confidence: 'high',
            soc_alternatives: [{ code: '2133', title: 'IT analysts', share: 0.2 }],
        });
        const twice = toPublicPortalJob(once as unknown as Record<string, unknown>);
        assert.deepEqual(twice.soc, {
            kind: 'single',
            code: '2134',
            title: 'Programmers and software development professionals',
            reason: '',
        });
        assert.equal('soc_alternatives' in twice, false);
    });

    it('includes why a confident code was matched, and the advert phrase when it adds one', () => {
        const view = jobsTableSocDisplay({
            soc_code: '2134',
            soc_title: 'Programmers and software development professionals',
            soc_confidence: 'high',
            soc_evidence: 'We are hiring a software engineer to build the platform.',
            sponsorship_reasons: [
                { id: 'occupation', text: 'This role matches Programmers and software development professionals, SOC 2134.' },
                { id: 'pay', text: 'The advert does not state pay, so the pay rule could not be checked.' },
            ],
        });
        assert.equal(view?.kind, 'single');
        if (view?.kind !== 'single') return;
        assert.equal(
            view.reason,
            'This role matches Programmers and software development professionals, SOC 2134. Matched from the advert: "We are hiring a software engineer to build the platform.".',
        );
        assert.equal(view.reason.includes('pay rule'), false);
    });

    it('includes the best-guess sentence for an uncertain match', () => {
        const view = jobsTableSocDisplay({
            soc_code: '3556',
            soc_confidence: 'low',
            soc_evidence: 'Partner Enablement Manager',
            soc_alternatives: [{ code: '3556', title: 'Sales accounts and business development managers', share: 0.62 }],
            sponsorship_reasons: [
                {
                    id: 'best_guess',
                    text: 'The occupation code is a best guess from the closest official job title ("sales manager"), so sponsorship was not assessed.',
                },
            ],
        });
        assert.equal(
            view?.kind === 'candidates' ? view.reason : '',
            'The occupation code is a best guess from the closest official job title ("sales manager"), so sponsorship was not assessed. Matched from the advert: "Partner Enablement Manager".',
        );
    });

    it('shows nothing for a low-confidence job that has no candidates yet', () => {
        assert.equal(
            jobsTableSocDisplay({
                soc_code: '2134',
                soc_title: 'Programmers',
                soc_confidence: 'low',
                soc_alternatives: null,
            }),
            null,
        );
    });
});
