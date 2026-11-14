import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatSearchSchema, jobChatInputSchema } from './chatIntent';
import { searchChatJobSources } from './chatDiscoverySources';
import { ChatLiveWebError, type ChatLiveWebResult } from './chatLiveWeb';
import { runJobChat } from './chatService';
import type { JobsPortalJob } from './types';
import { toPublicPortalCompany } from './publicResponse';

const now = Date.parse('2026-10-27T12:00:00Z');
const search = chatSearchSchema.parse({ role: 'software', where: '', kind: 'career', employerScope: 'civil-service' });
const job = (id: string, url: string): JobsPortalJob => ({
    id,
    title: `Software Engineer ${id}`,
    url,
    location: 'London, UK',
    company_id: 0,
    created_at: '',
    company: toPublicPortalCompany({ id: 0, trading_name: 'DWP Digital', licensed_sponsor: false }),
    description: 'Build software services for the public, working with a team on accessible government services.',
    listingSource: {
        kind: 'web', provider: 'employer-sites', publisher: 'GOV.UK Work Hub',
        retrievedAt: new Date(now).toISOString(), availability: 'source-listed', employerLicence: 'unknown',
    },
});
function result(jobs: JobsPortalJob[] = [], overrides: Partial<ChatLiveWebResult> = {}): ChatLiveWebResult {
    return {
        jobs, examined: jobs.length, excluded: 0, retrievedAt: new Date(now).toISOString(), cacheHit: false,
        boardsChecked: 1, boardsFailed: 0, boardsAvailable: 1, limitReached: false, ...overrides,
    };
}

test('a failed employer lookup preserves real government adverts and exposes incomplete coverage', async () => {
    const advert = job('web:government', 'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=2018673');
    const found = await searchChatJobSources(search, 'uk', {
        employerSearch: async () => { throw new Error('Employer discovery failed'); },
        governmentSearch: async () => result([advert]),
        now: () => now,
    });
    assert.deepEqual(found.jobs, [advert]);
    assert.equal(found.examined, 1);
    assert.equal(found.boardsChecked, 2);
    assert.equal(found.boardsFailed, 1);
    assert.equal(found.limitReached, true);
});

test('a government outage preserves employer adverts and all-source outage is unavailable', async () => {
    const advert = job('web:employer', 'https://careers.employer.co.uk/jobs/software-engineer-1234');
    const governmentSearch = async (): Promise<ChatLiveWebResult> => { throw new Error('Source unavailable'); };
    const found = await searchChatJobSources(search, 'uk', {
        employerSearch: async () => result([advert]), governmentSearch,
    });
    assert.deepEqual(found.jobs, [advert]);
    assert.equal(found.boardsFailed, 1);
    await assert.rejects(searchChatJobSources(search, 'uk', {
        employerSearch: governmentSearch, governmentSearch,
    }), ChatLiveWebError);
});

test('one advert discovered twice is deduplicated by its real URL before shared result limits', async () => {
    const advert = job('web:employer', 'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=2018673');
    const duplicate = { ...advert, id: 'web:government', url: `${advert.url}&utm_source=workhub` };
    const found = await searchChatJobSources(search, 'uk', {
        employerSearch: async () => result([advert]),
        governmentSearch: async () => result([duplicate]),
    });
    assert.equal(found.jobs.length, 1);
    assert.equal(found.jobs[0]!.id, advert.id);
    assert.equal(found.examined, 2);
    assert.equal(found.excluded, 1);
});

test('cancellation prevents source requests and aborts a request even when mocks return results', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const lookup = async () => { calls++; return result(); };
    await assert.rejects(searchChatJobSources(search, 'uk', {
        signal: controller.signal, employerSearch: lookup, governmentSearch: lookup,
    }), ChatLiveWebError);
    assert.equal(calls, 0);
});

test('Ireland source failure is not masked by an ineligible empty UK source', async () => {
    let governmentCalls = 0;
    await assert.rejects(searchChatJobSources(search, 'ireland', {
        employerSearch: async () => { throw new Error('No employer sources'); },
        governmentSearch: async () => { governmentCalls++; return result([], { boardsChecked: 0, boardsAvailable: 0 }); },
    }), ChatLiveWebError);
    assert.equal(governmentCalls, 0);
});

test('catalogue failure preserves independent proven adverts and explicitly reports unavailable catalogue', async () => {
    const civil = job('web:government', 'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=2018673');
    const unavailable = async (): Promise<never> => { throw new Error('Catalogue unavailable'); };
    const response = await runJobChat(jobChatInputSchema.parse({ message: 'civil service software', includeWeb: true }), {
        catalogCountry: 'uk', careerPremium: true, partTimePremium: true, partTimeBlocked: false,
    }, {
        careerFeed: unavailable, partTimeFeed: unavailable, webFeed: async () => result([civil]),
    });
    assert.equal(response.jobs.length, 1);
    assert.equal(response.catalogueStatus, 'unavailable');
    assert.equal(response.coverage, undefined);
    assert.match(response.message, /CAFY catalogue could not be checked/);
    assert.equal(response.evidence[civil.id]!.some((item) => item.includes('UK Civil Service Jobs')), true);
});

test('a catalogue outage without independent results does not claim no matching vacancies exist', async () => {
    const unavailable = async (): Promise<never> => { throw new Error('Catalogue unavailable'); };
    const response = await runJobChat(jobChatInputSchema.parse({ message: 'civil service software', includeWeb: false }), {
        catalogCountry: 'uk', careerPremium: true, partTimePremium: true, partTimeBlocked: false,
    }, { careerFeed: unavailable, partTimeFeed: unavailable });
    assert.equal(response.jobs.length, 0);
    assert.equal(response.catalogueStatus, 'unavailable');
    assert.match(response.message, /couldn’t complete your search/);
    assert.doesNotMatch(response.message, /haven’t found an exact match/);
    assert.equal(response.coverage, undefined);
});

test('Civil Service software conversation returns actual proven adverts, rejects a private supplier and preserves filters', async () => {
    const civil = job('web:government', 'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=2018673');
    const supplier = job('web:supplier', 'https://careers.private-supplier.co.uk/jobs/software-1234');
    supplier.company = toPublicPortalCompany({ id: 0, trading_name: 'Civil Service Software Supplier', licensed_sponsor: false });
    const empty = async () => ({ jobs: [], totalCount: 0, totalPages: 1, globalTotalCount: 0 });
    const response = await runJobChat(jobChatInputSchema.parse({ message: 'civil service software', includeWeb: true }), {
        catalogCountry: 'uk', careerPremium: true, partTimePremium: true, partTimeBlocked: false,
    }, {
        careerFeed: empty, partTimeFeed: empty,
        webFeed: async (criteria, country) => {
            assert.equal(criteria.role, 'software');
            assert.equal(criteria.employerScope, 'civil-service');
            return searchChatJobSources(criteria, country, {
                employerSearch: async () => result([supplier]),
                governmentSearch: async () => result([civil]),
            });
        },
    });
    assert.equal(response.search.employerScope, 'civil-service');
    assert.equal(response.jobs.length, 1);
    assert.equal(response.jobs[0]!.id, civil.id);
    assert.match(response.message, /1 matching.*software.*UK Civil Service/);
    assert.equal(response.message.length < 600, true);
    assert.equal(response.evidence[civil.id]!.some((item) => item.includes('UK Civil Service Jobs')), true);
    assert.equal(response.web?.examined, 2);
    assert.equal(response.web?.matched, 1);
    assert.equal(response.web?.excluded, 1);
});
