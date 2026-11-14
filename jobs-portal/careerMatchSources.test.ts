import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptCareerContext, decryptCareerCursor, encryptCareerContext, encryptCareerCursor } from './careerMatchCursor';
import { careerMatchInputSchema, careerJobFingerprint, CareerMatchError, runCareerMatches, type CareerMatchContext, type CareerMatchDependencies } from './careerMatchService';
import type { CareerMatchResponse, CareerProfile } from './careerMatchTypes';
import type { CareerWebReference } from './careerMatchWeb';
import type { JobsPortalJob } from './types';

const secret = 'fictional-sources-secret-for-pure-tests-0123456789';
const now = Date.parse('2026-10-28T12:00:00Z');
const context: CareerMatchContext = { userId: 'fictional-student', country: 'uk', careerPremium: true, partTimePremium: false, partTimeBlocked: false };
const profile: CareerProfile = { skills: [
    { name: 'Python', evidence: 'Built Python reporting projects.' },
    { name: 'SQL', evidence: 'Used SQL for financial reporting.' },
], roles: [{ title: 'Software Engineer', evidence: 'Worked as a Software Engineer.' }] };
const initial = (includeWeb = true) => careerMatchInputSchema.parse({
    resumeText: 'Worked as a Software Engineer. Built Python reporting projects. Used SQL for financial reporting.', includeWeb,
});
const row = (id: string, web = false): JobsPortalJob => ({
    id, title: 'Software Engineer', url: `https://example.org/adverts/${id}`, location: 'London',
    description: 'Develop Python services and SQL reporting. Test the applications and document project progress for the team.',
    created_at: '', company_id: 1, company: { id: 1, trading_name: 'Fictional Employer', licensed_sponsor: false,
        companies_house_name: null, url: null, url_linkedin: null, url_favicon: null, description: '',
        estimated_num_employees_label: null, ireland_permit_employer: false, cos_used_count_2025: null,
        open_to_sponsorship: null, show_recently_added_badge: false, added_to_register: null },
    ...(web ? { listingSource: { kind: 'web' as const, provider: 'employer-sites' as const, publisher: 'Greenhouse',
        retrievedAt: new Date(now).toISOString(), availability: 'source-listed' as const, employerLicence: 'unknown' as const } } : {}),
});
function fixture(catalogueSize = 2, webSize = 11) {
    const catalogue = Array.from({ length: catalogueSize }, (_, i) => row(`c-${i}`));
    const web = Array.from({ length: webSize }, (_, i) => row(`w-${String(i).padStart(2, '0')}`, true));
    const references: Record<string, CareerWebReference> = Object.fromEntries(web.map((job) => [job.id,
        { kind: 'employer-board', provider: 'greenhouse', token: 'fictional', region: 'global', companyId: 1, url: job.url }]));
    const coverage = { examined: webSize + 10, candidates: webSize, sourcesChecked: 2, sourcesFailed: 0, sourcesAvailable: 2, limitReached: true };
    let extracts = 0; let discoveries = 0; let webReloads = 0;
    const deps: CareerMatchDependencies = {
        cursorSecret: secret, now: () => now,
        extract: async () => { extracts++; return profile; },
        collect: async () => ({ jobs: catalogue, coverage: { catalogueScanned: catalogueSize, candidates: catalogueSize, sourceFailures: 0, limitReached: false } }),
        reload: async (ids) => catalogue.filter((job) => ids.includes(job.id)),
        webCollect: async (_search, _country, _queries, opts) => {
            discoveries++; assert.ok(opts && opts.timeoutMs! <= 20_000);
            return { jobs: web, references, coverage };
        },
        webReload: async (refs) => { webReloads++; return { jobs: web.filter((job) => refs.some((ref) => ref.url === job.url)), sourceFailures: 0 }; },
    };
    return { catalogue, web, references, coverage, deps, counts: () => ({ extracts, discoveries, webReloads }) };
}

/** Tokens issued before every search included employer sites carry no web coverage; late discovery serves them. */
async function legacyFirst(f: ReturnType<typeof fixture>, input = initial()): Promise<CareerMatchResponse> {
    const first = await runCareerMatches(input, context, { ...f.deps, webCollect: async () => ({ jobs: [], references: {},
        coverage: { examined: 0, candidates: 0, sourcesChecked: 0, sourcesFailed: 0, sourcesAvailable: 2, limitReached: false } }) });
    const legacy = (token: string | undefined, decrypt: typeof decryptCareerContext, encrypt: typeof encryptCareerContext) => {
        if (!token) return token;
        const snapshot = decrypt(token, context.userId, 'uk', secret, now);
        delete snapshot.coverage.web;
        return encrypt(snapshot, context.userId, secret, now);
    };
    return { ...first, coverage: { ...first.coverage, web: undefined },
        contextCursor: legacy(first.contextCursor, decryptCareerContext, encryptCareerContext)!,
        nextCursor: legacy(first.nextCursor, decryptCareerCursor, encryptCareerCursor) };
}

test('sparse catalogue automatically adds native web jobs to the same first five and preserves full CV review', async () => {
    const f = fixture();
    const fullProfile: CareerProfile = { ...profile, summary: 'CV projects: Built Python reporting projects.',
        projects: [{ label: 'Python reporting', evidence: 'Built Python reporting projects.' }],
        education: [{ label: 'BSc Computer Science', evidence: 'Studying BSc Computer Science.' }] };
    const page = await runCareerMatches(initial(), context, { ...f.deps, extract: async () => fullProfile });
    assert.equal(page.jobs.length, 5); assert.equal(page.hasMore, true);
    assert.ok(page.jobs.some(({ job }) => job.listingSource?.provider === 'employer-sites'));
    assert.deepEqual(page.profile, fullProfile); assert.equal(page.coverage.web?.candidates, 11);
    assert.equal(page.coverage.catalogueStatus, 'checked');
    assert.match(page.message, /five that suit your background best/);
    assert.doesNotMatch(JSON.stringify(page.jobs), /"score"|percentage/);
});

test('five-more pages mix sources without duplicates, rerunning CV analysis or rediscovering sources', async () => {
    const f = fixture();
    const first = await runCareerMatches(initial(), context, f.deps);
    f.web.forEach((job) => { job.listingSource!.retrievedAt = new Date(now + 60_000).toISOString(); });
    const second = await runCareerMatches({ cursor: first.nextCursor! }, context, f.deps);
    const third = await runCareerMatches({ contextCursor: second.contextCursor, message: 'five more' }, context, f.deps);
    assert.equal(first.jobs.length, 5); assert.equal(second.jobs.length, 5); assert.equal(third.jobs.length, 3);
    assert.equal(new Set([...first.jobs, ...second.jobs, ...third.jobs].map(({ job }) => job.url)).size, 13);
    assert.equal(third.hasMore, false);
    assert.deepEqual(f.counts(), { extracts: 1, discoveries: 1, webReloads: 2 });
});

test('observation timestamp changes survive continuation; changed advert contents do not', () => {
    const a = row('example', true); const b = structuredClone(a);
    b.listingSource!.retrievedAt = new Date(now + 60_000).toISOString();
    assert.equal(careerJobFingerprint(a), careerJobFingerprint(b));
    b.description += ' Requires an additional registration.';
    assert.notEqual(careerJobFingerprint(a), careerJobFingerprint(b));
});

test('web source failure preserves relevant catalogue results and honest source coverage', async () => {
    const f = fixture(6);
    const page = await runCareerMatches(initial(), context, { ...f.deps, webCollect: async () => { throw new Error('private-source-error'); } });
    assert.equal(page.state, 'results'); assert.equal(page.jobs.length, 5); assert.equal(page.hasMore, true);
    assert.equal(page.coverage.web?.sourcesFailed, 2); assert.equal(page.coverage.sourceFailures, 2);
    assert.doesNotMatch(JSON.stringify(page), /private-source-error/);
});

test('catalogue outage preserves independently supported web matches', async () => {
    const f = fixture(0);
    const page = await runCareerMatches(initial(), context, { ...f.deps, collect: async () => { throw new Error('private-catalogue-error'); } });
    assert.equal(page.state, 'results'); assert.equal(page.jobs.length, 5);
    assert.equal(page.coverage.catalogueStatus, 'unavailable');
    assert.ok(page.jobs.every(({ job }) => job.listingSource));
});

test('native web opt-out is retained through encrypted refinements', async () => {
    const f = fixture(2);
    const first = await runCareerMatches(initial(false), context, f.deps);
    const refined = await runCareerMatches({ contextCursor: first.contextCursor, search: first.search }, context, f.deps);
    assert.equal(first.jobs.length, 2); assert.equal(refined.jobs.length, 2);
    assert.equal(f.counts().discoveries, 0); assert.equal(first.coverage.web, undefined);
    assert.equal(decryptCareerContext(refined.contextCursor, context.userId, 'uk', secret, now).webEnabled, false);
});

test('every search checks employer and government sites beside a deep strong catalogue', async () => {
    const f = fixture(12);
    const page = await runCareerMatches(initial(), context, f.deps);
    assert.equal(page.jobs.length, 5); assert.equal(f.counts().discoveries, 1);
    assert.equal(page.coverage.web?.candidates, 11);
});

test('a deep weak catalogue pool still checks independent sources', async () => {
    const f = fixture(12);
    f.catalogue.forEach((job) => { job.description = 'Develop Python services. Write tests and communicate project progress to a software engineering team.'; });
    const page = await runCareerMatches(initial(), context, f.deps);
    assert.equal(f.counts().discoveries, 1);
    assert.ok(page.jobs.every(({ job }) => job.listingSource));
});

test('web candidates without native continuation provenance cannot become CV cards', async () => {
    const f = fixture(0);
    const page = await runCareerMatches(initial(), context, { ...f.deps, webCollect: async () => ({ jobs: f.web, references: {}, coverage: f.coverage }) });
    assert.equal(page.state, 'no-matches'); assert.equal(page.jobs.length, 0);
});

test('hard location criteria survive fallback rather than being broadened to fill five', async () => {
    const f = fixture(0);
    const page = await runCareerMatches(careerMatchInputSchema.parse({
        resumeText: 'Worked as a Software Engineer. Built Python reporting projects. Used SQL for financial reporting.',
        search: { role: 'software', where: 'Manchester', kind: 'career' },
    }), context, f.deps);
    assert.equal(page.state, 'no-matches'); assert.equal(page.jobs.length, 0);
});

test('mixed continuation source failure delivers available native results and retains failed entries for retry', async () => {
    const f = fixture(7, 10);
    const first = await runCareerMatches(initial(), context, f.deps);
    const second = await runCareerMatches({ cursor: first.nextCursor! }, context,
        { ...f.deps, webReload: async () => { throw new Error('private-web-failure'); } });
    assert.equal(second.state, 'results'); assert.equal(second.jobs.length, 2); assert.equal(second.hasMore, true);
    assert.ok(second.jobs.every(({ job }) => !job.listingSource));
    const retry = await runCareerMatches({ cursor: second.nextCursor! }, context, f.deps);
    assert.equal(retry.jobs.length, 5); assert.ok(retry.jobs.every(({ job }) => job.listingSource));
    assert.equal(new Set([...first.jobs, ...second.jobs, ...retry.jobs].map(({ job }) => job.id)).size, 12);
});

test('a wholly failed continuation retains the original unread offset for retry', async () => {
    const f = fixture(0);
    const first = await runCareerMatches(initial(), context, f.deps);
    const failed = await runCareerMatches({ cursor: first.nextCursor! }, context,
        { ...f.deps, webReload: async () => ({ jobs: [], sourceFailures: 1 }) });
    assert.equal(failed.state, 'unavailable');
    assert.equal(decryptCareerContext(failed.contextCursor, context.userId, 'uk', secret, now).offset, 5);
    const retry = await runCareerMatches({ contextCursor: failed.contextCursor, message: 'retry' }, context, f.deps);
    assert.equal(retry.jobs[0]?.job.id, 'w-05'); assert.equal(f.counts().extracts, 1);
});

test('cursor stores references, never external descriptions, and retains source binding', async () => {
    const f = fixture(0);
    const first = await runCareerMatches(initial(), context, f.deps);
    const cursor = decryptCareerCursor(first.nextCursor!, context.userId, 'uk', secret, now);
    assert.ok(cursor.entries.every((entry) => entry.webReference));
    assert.doesNotMatch(JSON.stringify(cursor), /Develop Python services/);
    assert.ok(cursor.entries.every((entry) => entry.webReference?.url === f.references[entry.id]?.url));
});

test('long legal native URLs produce a bounded shortlist instead of an expired-cursor error', async () => {
    const f = fixture(80, 40);
    f.catalogue.forEach((job) => { job.description = 'Develop Python services. Write tests and communicate project progress to the software engineering team.'; });
    f.web.forEach((job) => {
        job.url += `?reference=${'x'.repeat(1980)}`;
        // Each legal URL is <=2,048 characters, but forty references plus
        // profile/entry metadata can exceed the combined ciphertext budget.
        assert.ok(job.url.length <= 2048);
        f.references[job.id]!.url = job.url;
    });
    const first = await runCareerMatches(initial(), context, f.deps);
    assert.equal(first.jobs.length, 5); assert.ok(first.contextCursor.length <= 120000);
    const snapshot = decryptCareerContext(first.contextCursor, context.userId, 'uk', secret, now);
    assert.ok(snapshot.entries.length < 120); assert.ok(snapshot.entries.length >= 5);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 89_000);
    assert.equal(first.coverage.limitReached, true);
});

test('verified search directions start a first-job CV shortlist without forcing an extra role question', async () => {
    const f = fixture();
    const first = await runCareerMatches(initial(), context, { ...f.deps, extract: async () => ({ ...profile, roles: [],
        projects: [{ label: 'Python reporting', evidence: 'Built Python reporting projects.' }],
        searchDirections: [{ title: 'Software Engineer', skills: ['Python', 'SQL'],
            evidence: ['Built Python reporting projects.', 'Used SQL for financial reporting.'] }],
    }) });
    assert.equal(first.state, 'results'); assert.equal(first.jobs.length, 5);
    assert.equal(first.profile.roles.length, 0);
    assert.equal(first.profile.searchDirections?.[0]?.title, 'Software Engineer');
    assert.ok(first.jobs.every((match) => match.reasons.some((reason) => /suggest|direction/i.test(reason))));
});

test('a deep catalogue tail is filled by one late native round, then continued five at a time without new CV analysis', async () => {
    const f = fixture(12, 10);
    const pages = [await legacyFirst(f)];
    assert.equal(f.counts().discoveries, 0);
    while (pages.at(-1)!.hasMore) pages.push(await runCareerMatches({ cursor: pages.at(-1)!.nextCursor! }, context, f.deps));
    assert.deepEqual(pages.map((page) => page.jobs.length), [5, 5, 5, 5, 2]);
    assert.equal(pages[2]!.jobs.filter((match) => match.job.listingSource).length, 3);
    const all = pages.flatMap((page) => page.jobs);
    assert.equal(all.length, 22);
    assert.equal(new Set(all.map((match) => match.job.url)).size, 22);
    assert.deepEqual(f.counts(), { extracts: 1, discoveries: 1, webReloads: 2 });
    const snapshot = decryptCareerContext(pages.at(-1)!.contextCursor, context.userId, 'uk', secret, now);
    assert.ok(snapshot.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.urlHash!)));
    assert.equal(snapshot.issuedAt, now);
    assert.equal(snapshot.expiresAt, now + 20 * 60_000);
    assert.ok(snapshot.coverage.web);
});

test('an exact multiple of five still offers the previously unattempted native source check', async () => {
    const f = fixture(10, 5);
    const first = await legacyFirst(f);
    const second = await runCareerMatches({ cursor: first.nextCursor! }, context, f.deps);
    assert.equal(second.jobs.length, 5);
    assert.equal(second.hasMore, true);
    assert.equal(f.counts().discoveries, 0);
    const third = await runCareerMatches({ cursor: second.nextCursor! }, context, f.deps);
    assert.equal(third.jobs.length, 5);
    assert.ok(third.jobs.every((match) => match.job.listingSource));
    assert.equal(third.hasMore, false);
    assert.equal(f.counts().discoveries, 1);
});

test('late discovery rejects previously consumed apply URLs across new IDs, tracking, fragments and trailing slashes', async () => {
    const f = fixture(12, 10);
    f.web[0]!.url = `${f.catalogue[0]!.url}/?utm_source=google#apply`;
    f.references[f.web[0]!.id]!.url = f.web[0]!.url;
    const pages = [await legacyFirst(f)];
    while (pages.at(-1)!.hasMore) pages.push(await runCareerMatches({ cursor: pages.at(-1)!.nextCursor! }, context, f.deps));
    const all = pages.flatMap((page) => page.jobs);
    assert.equal(all.length, 21);
    assert.equal(all.some((match) => match.job.id === 'w-00'), false);
    assert.equal(f.counts().discoveries, 1);
    assert.equal(f.counts().extracts, 1);
});

test('native opt-out stays catalogue-only even when the final page is short', async () => {
    const f = fixture(12, 10);
    const first = await runCareerMatches(initial(false), context, f.deps);
    const second = await runCareerMatches({ cursor: first.nextCursor! }, context, f.deps);
    const third = await runCareerMatches({ cursor: second.nextCursor! }, context, f.deps);
    assert.equal(third.jobs.length, 2);
    assert.equal(third.hasMore, false);
    assert.equal(third.coverage.web, undefined);
    assert.equal(f.counts().discoveries, 0);
});

test('older tokens without complete URL identities skip unsafe late discovery', async () => {
    const f = fixture(12, 10);
    const first = await legacyFirst(f);
    const snapshot = decryptCareerContext(first.contextCursor, context.userId, 'uk', secret, now);
    snapshot.entries = snapshot.entries.map(({ urlHash: _hash, ...entry }) => entry);
    const legacy = encryptCareerContext(snapshot, context.userId, secret, now);
    const second = await runCareerMatches({ contextCursor: legacy, message: 'more' }, context, f.deps);
    const third = await runCareerMatches({ cursor: second.nextCursor! }, context, f.deps);
    assert.equal(third.jobs.length, 2);
    assert.equal(third.hasMore, false);
    assert.equal(f.counts().discoveries, 0);
});

test('retained identities, including consumed catalogue rows, keep the overall shortlist capped at 120', async () => {
    const f = fixture(120, 10);
    let page = await runCareerMatches(initial(), context, f.deps);
    let count = page.jobs.length;
    while (page.hasMore) {
        page = await runCareerMatches({ cursor: page.nextCursor! }, context, f.deps);
        count += page.jobs.length;
    }
    assert.equal(count, 120);
    assert.equal(f.counts().discoveries, 1);
    assert.equal(page.hasMore, false);
    const snapshot = decryptCareerContext(page.contextCursor, context.userId, 'uk', secret, now);
    assert.equal(snapshot.entries.length, 120);
});

test('late source failure retains current catalogue cards, avoids automatic rediscovery and allows explicit retry', async () => {
    const f = fixture(12, 10);
    let attempts = 0;
    const deps: CareerMatchDependencies = { ...f.deps,
        webCollect: async (...args) => {
            if (++attempts === 1) throw new Error('private source failure');
            return f.deps.webCollect!(...args);
        },
    };
    const first = await runCareerMatches(initial(), context, deps);
    const second = await runCareerMatches({ cursor: first.nextCursor! }, context, deps);
    const third = await runCareerMatches({ cursor: second.nextCursor! }, context, deps);
    assert.equal(third.jobs.length, 2);
    assert.equal(third.state, 'results');
    assert.equal(third.coverage.web?.sourcesFailed, 2);
    const more = await runCareerMatches({ contextCursor: third.contextCursor, message: 'more' }, context, deps);
    assert.equal(more.state, 'unavailable');
    assert.equal(attempts, 1);
    const retry = await runCareerMatches({ contextCursor: more.contextCursor, message: 'retry' }, context, deps);
    assert.equal(retry.jobs.length, 5);
    assert.equal(attempts, 2);
    assert.equal(f.counts().extracts, 1);
    assert.doesNotMatch(JSON.stringify(third), /private source/);
});

test('parent cancellation during late discovery never publishes the two already gathered catalogue cards', async () => {
    const f = fixture(12, 10);
    const first = await legacyFirst(f);
    const second = await runCareerMatches({ cursor: first.nextCursor! }, context, f.deps);
    const parent = new AbortController();
    await assert.rejects(runCareerMatches({ cursor: second.nextCursor! }, context, {
        ...f.deps, signal: parent.signal,
        webCollect: async () => { parent.abort(); throw new Error('cancelled'); },
    }), (error: unknown) => error instanceof CareerMatchError && error.code === 'CANCELLED');
});
