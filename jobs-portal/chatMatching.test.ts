import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatSearchSchema, type ChatSearch } from './chatIntent';
import { advertisedChatPay, chatCivilServiceEvidence, matchChatJob } from './chatMatching';
import { chatCatalogueFilters, searchChatCatalogue } from './chatCatalogue';
import { toPublicPortalJob } from './publicResponse';
import type { JobsPortalJob } from './types';

function search(overrides: Partial<ChatSearch> = {}): ChatSearch {
    return chatSearchSchema.parse({ role: '', where: '', kind: 'career', ...overrides });
}

function job(overrides: Partial<JobsPortalJob> = {}): JobsPortalJob {
    return toPublicPortalJob({
        id: 1,
        title: 'Data Analyst',
        location: 'London, United Kingdom',
        url: 'https://employer.example/jobs/1',
        company_id: 7,
        created_at: '2026-10-27T00:00:00Z',
        department: 'Data',
        level: 'Junior',
        job_type: 'Full-time',
        company: { id: 7, trading_name: 'North London NHS Foundation Trust', licensed_sponsor: true },
        description: 'Work with data and deliver accurate reports.',
        ...overrides,
        ...('jobType' in overrides ? { job_type: overrides.jobType } : {}),
    });
}

test('NHS analyst London requires employer AND location AND role', () => {
    const request = search({ role: 'data analyst', employer: 'NHS', where: 'London' });
    assert.equal(matchChatJob(job(), request).matches, true);
    assert.equal(matchChatJob(job({ location: 'Manchester' }), request).matches, false);
    assert.equal(
        matchChatJob(job({ company: { ...job().company!, trading_name: 'Private Analytics Limited' } }), request)
            .matches,
        false,
    );
    assert.equal(matchChatJob(job({ title: 'Data Engineer' }), request).matches, false);
});

test('Civil Service software matches an actual occupation with official institution provenance', () => {
    const posting = job({
        title: 'Software Developer',
        company: {
            ...job().company!,
            trading_name: 'DWP Digital',
            url: 'https://www.gov.uk/government/organisations/department-for-work-pensions',
        },
    });
    const result = matchChatJob(posting, search({ role: 'software', employerScope: 'civil-service' }));
    assert.equal(result.matches, true);
    assert.match(result.evidence.join('\n'), /DWP Digital.*official UK government organisation link/);
    assert.equal(
        matchChatJob(
            { ...posting, location: 'Manchester' },
            search({ role: 'software', where: 'London', employerScope: 'civil-service' }),
        ).matches,
        false,
    );
});

test('actual Civil Service Jobs advert URLs are direct source evidence', () => {
    assert.match(
        chatCivilServiceEvidence(
            job({ url: 'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=1234567' }),
        )!,
        /Civil Service Jobs/,
    );
    for (const url of [
        'https://www.civilservicejobs.service.gov.uk/',
        'https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi',
        'https://www.civilservicejobs.service.gov.uk.evil.com/csr/jobs.cgi?jcode=1234567',
        'http://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=1234567',
        'https://www.civilservicejobs.service.gov.uk:8443/csr/jobs.cgi?jcode=1234567',
        'https://user:password@www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=1234567',
    ])
        assert.equal(chatCivilServiceEvidence(job({ url })), undefined);
});

test('a Civil Service title, advert mention or unverified employer name cannot prove the scope', () => {
    const posting = job({
        title: 'Civil Service Software Developer',
        description: 'We work with the Civil Service and government clients.',
        company: {
            ...job().company!,
            trading_name: 'Civil Service Careers Limited',
            url: 'https://privatecareers.com',
        },
    });
    assert.equal(chatCivilServiceEvidence(posting), undefined);
    assert.equal(matchChatJob(posting, search({ role: 'software', employerScope: 'civil-service' })).matches, false);
});

test('department name requires its matching official identity link, not arbitrary gov.uk content', () => {
    const base = job();
    for (const url of [
        null,
        'https://privatecareers.com',
        'https://www.gov.uk',
        'https://www.gov.uk/government/organisations/home-office',
        'https://www.gov.uk.evil.com/government/organisations/department-for-work-pensions',
    ]) {
        assert.equal(
            chatCivilServiceEvidence(job({ company: { ...base.company!, trading_name: 'DWP Digital', url } })),
            undefined,
        );
    }
    assert.ok(
        chatCivilServiceEvidence(
            job({
                company: { ...base.company!, trading_name: 'DWP Digital', url: 'https://dwpdigital.blog.gov.uk/jobs' },
            }),
        ),
    );
});

for (const [name, slug] of [
    ['DWP', 'department-for-work-pensions'],
    ['DVLA', 'driver-and-vehicle-licensing-agency'],
    ['HMRC', 'hm-revenue-customs'],
    ['Home Office', 'home-office'],
    ['GDS', 'government-digital-service'],
] as const) {
    test(`known department aliases require their actual official organisation URL: ${name}`, () => {
        assert.ok(
            chatCivilServiceEvidence(
                job({
                    company: {
                        ...job().company!,
                        trading_name: name,
                        url: `https://www.gov.uk/government/organisations/${slug}`,
                    },
                }),
            ),
        );
    });
}

test('NHS and unrelated public bodies are not silently classified as the Civil Service', () => {
    assert.equal(
        chatCivilServiceEvidence(
            job({
                company: {
                    ...job().company!,
                    trading_name: 'NHS England',
                    url: 'https://www.gov.uk/government/organisations/department-of-health-and-social-care',
                },
            }),
        ),
        undefined,
    );
});

test('location never matches description and respects whole words', () => {
    assert.equal(
        matchChatJob(
            job({ location: 'Bristol', description: 'Our London head office supports this Bristol vacancy.' }),
            search({ where: 'London' }),
        ).matches,
        false,
    );
    assert.equal(matchChatJob(job({ location: 'Londonderry' }), search({ where: 'London' })).matches, false);
    assert.equal(matchChatJob(job({ location: 'Reading, Berkshire' }), search({ where: 'Reading' })).matches, true);
});

test('role tokens are conjunctive and preserve C++, C# and .NET distinctions', () => {
    assert.equal(
        matchChatJob(
            job({ title: 'Software Engineer - C++', department: 'Engineering' }),
            search({ role: 'C++ engineer' }),
        ).matches,
        true,
    );
    assert.equal(
        matchChatJob(
            job({ title: 'Software Engineer - C#', department: 'Engineering' }),
            search({ role: 'C++ engineer' }),
        ).matches,
        false,
    );
    assert.equal(
        matchChatJob(job({ title: '.NET Developer', department: 'Engineering' }), search({ role: '.NET developer' }))
            .matches,
        true,
    );
    assert.equal(
        matchChatJob(
            job({ title: 'Customer Service Advisor', description: 'Work with our data analyst team.' }),
            search({ role: 'data analyst' }),
        ).matches,
        false,
    );
});

test('employment type and level are hard catalog filters, not preferences', () => {
    assert.equal(matchChatJob(job(), search({ levels: ['Junior'], jobTypes: ['Full-time'] })).matches, true);
    assert.equal(matchChatJob(job({ level: 'Senior' }), search({ levels: ['Junior'] })).matches, false);
    assert.equal(matchChatJob(job({ jobType: null }), search({ jobTypes: ['Internship'] })).matches, false);
    assert.equal(matchChatJob(job({ jobType: 'Internship' }), search({ jobTypes: ['Internship'] })).matches, true);
});

test('remote evidence rejects hybrid, office requirements, remote clients and negations', () => {
    const request = search({ workingArrangement: 'remote' });
    assert.equal(matchChatJob(job({ location: 'Remote' }), request).matches, true);
    assert.equal(
        matchChatJob(job({ description: 'This is a fully remote position within the UK.' }), request).matches,
        true,
    );
    for (const description of [
        'You will support remote clients and remote networks.',
        'Hybrid working, with work from home on Fridays.',
        'This is not a remote role.',
        'Remote working is not supported.',
        'Work from home one day per week.',
        'Remote working may be possible after probation.',
        'Remote working is not an option.',
        'Remote working with 2 days per week in the office.',
        'Our offices are in London.',
    ])
        assert.equal(matchChatJob(job({ description }), request).matches, false, description);
});

test('hybrid infrastructure is not evidence of a hybrid working arrangement', () => {
    assert.equal(
        matchChatJob(
            job({ description: 'Build a hybrid model combining cloud and on-premise infrastructure.' }),
            search({ workingArrangement: 'hybrid' }),
        ).matches,
        false,
    );
    assert.equal(
        matchChatJob(
            job({ description: 'Hybrid working with two days in the office.' }),
            search({ workingArrangement: 'hybrid' }),
        ).matches,
        true,
    );
});

test('salary minimum checks the lower range bound and explicit comparable units', () => {
    const request = search({ salary: { min: 40000, currency: 'GBP', period: 'year' } });
    assert.equal(matchChatJob(job({ salary: '£40,000 - £50,000 per annum' }), request).matches, true);
    for (const salary of [
        '£30,000 - £45,000 per annum',
        'Up to £45,000 per annum',
        '£45,000',
        '€45,000 per annum',
        '£25 per hour',
        '£45,000 per annum pro rata',
        '£40,000 - €50,000 per annum',
    ]) {
        assert.equal(matchChatJob(job({ salary }), request).matches, false, salary);
    }
    assert.equal(matchChatJob(job({ salary: 'From £42,000 per annum' }), request).matches, true);
    assert.equal(matchChatJob(job({ salary: '£45k per year' }), request).matches, true);
});

test('salary maximum checks the upper bound and does not infer an upper bound for from', () => {
    const request = search({ salary: { max: 45000, currency: 'GBP', period: 'year' } });
    assert.equal(matchChatJob(job({ salary: '£40,000 - £45,000 per annum' }), request).matches, true);
    assert.equal(matchChatJob(job({ salary: '£40,000 - £55,000 per annum' }), request).matches, false);
    assert.equal(matchChatJob(job({ salary: 'From £40,000 per annum' }), request).matches, false);
});

test('missing salary can use labelled advert evidence but not benefits or arbitrary numbers', () => {
    assert.equal(
        advertisedChatPay(job({ description: 'Salary: £45,000 per annum.\nBenefits include pension.' }))[0]?.min,
        45000,
    );
    assert.equal(
        advertisedChatPay(job({ description: 'Benefits include a £2,000 per annum travel allowance.' })).length,
        0,
    );
    assert.equal(
        advertisedChatPay(job({ description: 'Salary: £45,000 per annum plus £5,000 annual bonus.' })).length,
        0,
    );
});

test('licensed employer is distinct from explicit advert sponsorship', () => {
    assert.equal(matchChatJob(job(), search({ sponsorship: 'licensed-employer' })).matches, true);
    assert.equal(matchChatJob(job(), search({ sponsorship: 'advert-confirmed' })).matches, false);
    assert.equal(
        matchChatJob(
            job({ description: 'Visa sponsorship is available for this role.' }),
            search({ sponsorship: 'advert-confirmed' }),
        ).matches,
        true,
    );
    for (const description of [
        'We cannot provide visa sponsorship. Visa sponsorship is available for some other roles.',
        'We are not able to sponsor candidates for this role.',
        'Sponsorship cannot be offered for this position.',
        'No visa sponsorship is available.',
        'You must have the right to work without sponsorship.',
        'We can sponsor professional qualifications and team events.',
        'Visa sponsorship is available if the team agrees.',
        'Visa sponsorship may be available.',
    ])
        assert.equal(
            matchChatJob(job({ description }), search({ sponsorship: 'advert-confirmed' })).matches,
            false,
            description,
        );
});

test('advert-confirmed sponsorship requires both licence metadata and explicit role wording', () => {
    const request = search({ sponsorship: 'advert-confirmed' });
    const description = 'Visa sponsorship is available for this role.';
    const supported = matchChatJob(job({ description }), request);
    assert.equal(supported.matches, true);
    assert.match(supported.evidence.join('\n'), /licensed UK sponsor/);
    assert.match(supported.evidence.join('\n'), /Sponsorship wording in advert/);
    assert.equal(
        matchChatJob(job({ description, company: { ...job().company!, licensed_sponsor: false } }), request).matches,
        false,
    );
    assert.equal(matchChatJob(job({ description, company: undefined }), request).matches, false);
    assert.equal(matchChatJob(job({ description: 'We are a sponsor-licensed employer.' }), request).matches, false);
});

test('contradictory salary field and current advert cannot establish a pay match', () => {
    assert.equal(
        matchChatJob(
            job({ salary: '£45,000 per annum', description: 'Salary: £30,000 per annum.' }),
            search({ salary: { min: 40000, currency: 'GBP', period: 'year' } }),
        ).matches,
        false,
    );
});

test('unsupported requirements cannot silently become matching results', () => {
    assert.equal(matchChatJob(job(), search({ unsupported: ['Within 30 minutes by train'] })).matches, false);
});

type Row = Record<string, unknown>;
interface QueryCall {
    table: string;
    operations: Array<[string, unknown]>;
}
function mockClient(
    tables: Record<string, Row[]>,
    errors: Record<string, { code: string; message: string }> = {},
): { client: SupabaseClient; calls: QueryCall[] } {
    const calls: QueryCall[] = [];
    return {
        calls,
        client: {
            from: (table: string) => {
                const call: QueryCall = { table, operations: [] };
                calls.push(call);
                let start = 0,
                    end = Number.POSITIVE_INFINITY,
                    cap = Number.POSITIVE_INFINITY;
                const ids = new Map<string, unknown[]>();
                const query = {
                    select: (columns: string, options?: unknown) => {
                        call.operations.push(['select', { columns, options }]);
                        return query;
                    },
                    or: (value: string) => {
                        call.operations.push(['or', value]);
                        return query;
                    },
                    in: (column: string, values: unknown[]) => {
                        call.operations.push(['in', { column, values }]);
                        ids.set(column, values);
                        return query;
                    },
                    order: (column: string) => {
                        call.operations.push(['order', column]);
                        return query;
                    },
                    limit: (value: number) => {
                        call.operations.push(['limit', value]);
                        cap = value;
                        return query;
                    },
                    range: (from: number, to: number) => {
                        call.operations.push(['range', [from, to]]);
                        start = from;
                        end = to + 1;
                        return query;
                    },
                    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
                        const rows = (tables[table] || []).filter((row) =>
                            [...ids].every(([column, values]) => values.includes(row[column])),
                        );
                        return Promise.resolve({
                            data: rows.slice(start, Math.min(end, start + cap)),
                            count: rows.length,
                            error: errors[table] || null,
                        }).then(resolve, reject);
                    },
                };
                return query;
            },
        } as unknown as SupabaseClient,
    };
}

test('coarse query has independent company AND location AND role dimensions', () => {
    const filters = chatCatalogueFilters(
        search({ role: 'data analyst', employer: 'NHS', where: 'London', jobTypes: ['Full-time'], levels: ['Junior'] }),
        { companyIds: [7], partTimeCompanyIds: [] },
    );
    assert.deepEqual(filters, [
        { kind: 'or', value: 'title.ilike.%data%,department.ilike.%data%' },
        { kind: 'or', value: 'title.ilike.%analyst%,department.ilike.%analyst%' },
        { kind: 'or', value: 'location.ilike.%london%' },
        { kind: 'or', value: 'company_id.in.(7)' },
        { kind: 'in', column: 'job_type', values: ['Full-time'] },
        { kind: 'in', column: 'level', values: ['Junior'] },
    ]);
});

test('retrieval verifies evidence before free cap and reports partial scan honestly', async () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({
        id: index + 1,
        company_id: 7,
        title: 'Data Analyst',
        url: `https://employer.example/jobs/${index}`,
        location: 'London',
        description: index < 2 ? 'This is a fully remote role.' : 'We support remote customers.',
        created_at: '2026-10-27T00:00:00Z',
        level: 'Junior',
        job_type: 'Full-time',
        salary: null,
    }));
    const fake = mockClient({ jobs: rows, companies: [{ id: 7, trading_name: 'North London NHS Foundation Trust' }] });
    const result = await searchChatCatalogue(
        search({ role: 'data analyst', where: 'London', employer: 'NHS', workingArrangement: 'remote' }),
        'uk',
        1,
        { client: fake.client },
    );
    assert.equal(result.jobs.length, 1);
    assert.equal(result.totalCount, 2);
    assert.deepEqual(result.coverage, { scanned: 100, limitReached: true });
    assert.match(result.evidence['1']!.join('\n'), /fully remote/);
    const selection = fake.calls.find((call) => call.table === 'jobs')!;
    assert.equal(selection.operations[0]![0], 'select');
    assert.equal(selection.operations.at(-1)![0], 'range');
    assert.ok(selection.operations.some(([operation, value]) => operation === 'or' && value === 'company_id.in.(7)'));
});

test('retrieval continues beyond first page when descriptions do not satisfy the ask', async () => {
    const rows = Array.from({ length: 125 }, (_, index) => ({
        id: index + 1,
        company_id: 7,
        title: 'Data Analyst',
        url: `https://employer.example/jobs/${index}`,
        location: 'London',
        description: index === 124 ? 'Fully remote role.' : 'Hybrid working.',
        created_at: '2026-10-27T00:00:00Z',
    }));
    const fake = mockClient({ jobs: rows, companies: [{ id: 7, trading_name: 'Example Employer' }] });
    const result = await searchChatCatalogue(
        search({ role: 'data analyst', workingArrangement: 'remote' }),
        'uk',
        undefined,
        { client: fake.client },
    );
    assert.equal(result.jobs[0]?.id, '125');
    assert.equal(result.totalCount, 1);
    assert.deepEqual(result.coverage, { scanned: 125, limitReached: false });
});

test('part-time employer hydration keeps original part-time company identity and city fallback', async () => {
    const fake = mockClient({
        part_time_jobs_UK: [
            {
                id: 5,
                company_id: null,
                part_time_company_id: 9,
                title: 'Barista',
                location: '',
                city: 'Manchester',
                description: 'Serving coffee.',
                created_at: '2026-10-27T00:00:00Z',
                job_type: 'Part-time',
            },
        ],
        part_time_companies_UK: [{ id: 9, trading_name: 'Student Coffee' }],
    });
    const result = await searchChatCatalogue(
        search({ kind: 'part-time', role: 'barista', where: 'Manchester', employer: 'Student Coffee' }),
        'uk',
        undefined,
        { client: fake.client },
    );
    assert.equal(result.jobs[0]?.company?.trading_name, 'Student Coffee');
    assert.equal(result.jobs[0]?.company?.licensed_sponsor, false);
    assert.equal(result.jobs[0]?.company_id, 9);
    assert.equal(result.jobs[0]?.location, 'Manchester');
    const select = fake.calls.find((call) => call.table === 'part_time_jobs_UK')!;
    assert.ok(
        select.operations.some(([operation, value]) => operation === 'or' && value === 'part_time_company_id.in.(9)'),
    );
});

test('unsupported input does not create a client or query a catalogue', async () => {
    const fake = mockClient({});
    const result = await searchChatCatalogue(search({ unsupported: ['public-sector ownership'] }), 'uk', undefined, {
        client: fake.client,
    });
    assert.equal(result.jobs.length, 0);
    assert.equal(fake.calls.length, 0);
});

test('company transport failure is unavailable rather than a false successful zero', async () => {
    const fake = mockClient(
        { jobs: [{ id: 1, company_id: 7, title: 'Data Analyst', location: 'London' }] },
        { companies: { code: '503', message: 'Internal transport information must not be returned to users.' } },
    );
    await assert.rejects(
        searchChatCatalogue(search({ role: 'data analyst' }), 'uk', undefined, { client: fake.client }),
        { message: 'Chat catalogue employer data is unavailable' },
    );
});

test('bounded scan does not present zero as an exhaustive catalogue result', async () => {
    const fake = mockClient({
        jobs: Array.from({ length: 1200 }, (_, index) => ({
            id: index + 1,
            company_id: 7,
            title: 'Data Analyst',
            location: 'London',
            description: 'Hybrid working.',
            created_at: '2026-10-27T00:00:00Z',
        })),
        companies: [{ id: 7, trading_name: 'Example Employer' }],
    });
    const result = await searchChatCatalogue(
        search({ role: 'data analyst', workingArrangement: 'remote' }),
        'uk',
        undefined,
        { client: fake.client },
    );
    assert.equal(result.jobs.length, 0);
    assert.deepEqual(result.coverage, { scanned: 1000, limitReached: true });
    assert.equal(fake.calls.filter((call) => call.table === 'jobs').length, 10);
});

test('catalogue applies institution evidence before counts, visibility cap and employer results', async () => {
    const fake = mockClient({
        jobs: [
            {
                id: 1,
                company_id: 7,
                title: 'Software Developer',
                location: 'London',
                url: 'https://privatecareers.com/jobs/1',
                created_at: '2026-10-27T00:00:00Z',
            },
            {
                id: 2,
                company_id: 8,
                title: 'Software Developer',
                location: 'London',
                url: 'https://department.atscompany.com/jobs/2',
                created_at: '2026-10-27T00:00:00Z',
            },
        ],
        companies: [
            { id: 7, trading_name: 'Civil Service Software Limited', url: 'https://privatecareers.com' },
            {
                id: 8,
                trading_name: 'DWP Digital',
                url: 'https://www.gov.uk/government/organisations/department-for-work-pensions',
            },
        ],
    });
    const result = await searchChatCatalogue(search({ role: 'software', employerScope: 'civil-service' }), 'uk', 1, {
        client: fake.client,
    });
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0]!.id, '2');
    assert.equal(result.totalCount, 1);
    assert.match(result.evidence['2']!.join('\n'), /official UK government organisation link/);
    assert.ok(
        fake.calls.some(
            (call) =>
                call.table === 'jobs' &&
                call.operations.some(
                    ([operation, value]) =>
                        operation === 'or' && value === 'title.ilike.%software%,department.ilike.%software%',
                ),
        ),
    );
});
