import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chatSearchSchema, type ChatSearch } from './chatIntent';
import { ChatLiveWebError, searchChatEmployerWebJobs } from './chatLiveWeb';
import type { EmployerBoard, EmployerBoardResult } from './chatEmployerSources';
import type { JobsPortalJob } from './types';

const NOW = Date.parse('2026-10-27T12:00:00Z');
function search(fields: Partial<ChatSearch> = {}): ChatSearch {
    return chatSearchSchema.parse({ role: 'data analyst', where: 'London', kind: 'career', ...fields });
}
interface Query {
    relation: string;
    columns: string;
    filters: Array<{ kind: 'or' | 'in'; value: string; values?: unknown[] }>;
    orders: Array<{ column: string; ascending: boolean }>;
    limit: number;
}
interface ResponseData {
    data: unknown[] | null;
    error: { code: string; message: string } | null;
    count?: number;
}
function mockDb(resolve: (query: Query) => ResponseData | Promise<ResponseData>): {
    client: SupabaseClient;
    queries: Query[];
} {
    const queries: Query[] = [];
    const client = {
        from(relation: string) {
            const state: Query = { relation, columns: '', filters: [], orders: [], limit: 0 };
            const builder = {
                select(columns: string) {
                    state.columns = columns;
                    return builder;
                },
                or(value: string) {
                    state.filters.push({ kind: 'or', value });
                    return builder;
                },
                in(column: string, values: unknown[]) {
                    state.filters.push({ kind: 'in', value: column, values });
                    return builder;
                },
                order(column: string, options: { ascending: boolean }) {
                    state.orders.push({ column, ascending: options.ascending });
                    return builder;
                },
                limit(limit: number) {
                    state.limit = limit;
                    return builder;
                },
                then(onFulfilled: (value: ResponseData) => unknown, onRejected?: (reason: unknown) => unknown) {
                    const snapshot: Query = {
                        ...state,
                        filters: state.filters.map((filter) => ({ ...filter })),
                        orders: [...state.orders],
                    };
                    queries.push(snapshot);
                    return Promise.resolve()
                        .then(() => resolve(snapshot))
                        .then(onFulfilled, onRejected);
                },
            };
            return builder;
        },
    } as unknown as SupabaseClient;
    return { client, queries };
}
function company(id = 1, fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        trading_name: `Actual Analytics ${id}`,
        companies_house_name: `Actual Analytics ${id} Limited`,
        url: `https://actualanalytics${id}.com`,
        careers_url: `https://job-boards.greenhouse.io/actual-board-${id}`,
        ats_provider: 'greenhouse',
        ats_board_token: `actual-board-${id}`,
        licensed_sponsor: true,
        ...fields,
    };
}
function observation(fields: Partial<EmployerBoardResult> = {}): EmployerBoardResult {
    return {
        jobs: [],
        examined: 0,
        excluded: 0,
        retrievedAt: new Date(NOW).toISOString(),
        cacheHit: false,
        limitReached: false,
        ...fields,
    };
}
function webJob(id: string): JobsPortalJob {
    return {
        id,
        title: 'Data Analyst',
        location: 'London, UK',
        description: 'Analyse business data and present accurate reports for stakeholders.',
        url: `https://job-boards.greenhouse.io/actual/jobs/${id}`,
        company_id: 1,
        created_at: '',
    };
}
function response(data: unknown[] = [], count?: number): ResponseData {
    return { data, error: null, ...(count !== undefined ? { count } : {}) };
}

test('named employer discovery keeps name tokens conjunctive and never queries all job rows', async () => {
    const db = mockDb(() =>
        response([
            company(1, { trading_name: 'Actual Analytics', companies_house_name: 'Actual Analytics Limited' }),
            company(2, { trading_name: 'Other Employer', companies_house_name: 'Other Employer Limited' }),
        ]),
    );
    const called: EmployerBoard[] = [];
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        now: () => NOW,
        fetchBoard: async (board) => {
            called.push(board);
            return observation();
        },
    });
    assert.equal(db.queries.length, 1);
    assert.equal(db.queries[0]!.relation, 'companies');
    assert.deepEqual(
        db.queries[0]!.filters.map((filter) => filter.value),
        [
            'trading_name.ilike.%actual%,companies_house_name.ilike.%actual%',
            'trading_name.ilike.%analytics%,companies_house_name.ilike.%analytics%',
        ],
    );
    assert.equal(called.length, 1);
    assert.equal(called[0]!.token, 'actual-board-1');
    assert.equal(result.boardsChecked, 1);
    assert.equal(result.boardsFailed, 0);
    assert.equal(result.boardsAvailable, 1);
});

test('Civil Service scope skips unrelated private ATS boards before making public requests', async () => {
    const db = mockDb((query) => response(query.relation === 'companies' ? [company()] : [{ company_id: 1 }]));
    let requests = 0;
    const found = await searchChatEmployerWebJobs(search({ role: 'software', where: '', employerScope: 'civil-service' }), 'uk', {
        client: db.client,
        fetchBoard: async () => { requests++; return observation(); },
    });
    assert.equal(requests, 0);
    assert.equal(found.boardsChecked, 0);
    assert.equal(found.boardsAvailable, 0);
    assert.deepEqual(found.jobs, []);
});

test('Civil Service scope retains an ATS board backed by exact government employer identity', async () => {
    const db = mockDb((query) => response(query.relation === 'companies' ? [company(1, {
        trading_name: 'DWP Digital',
        companies_house_name: 'Department for Work and Pensions',
        url: 'https://www.gov.uk/government/organisations/department-for-work-pensions',
    })] : [{ company_id: 1 }]));
    let requests = 0;
    const found = await searchChatEmployerWebJobs(search({ role: 'software', where: '', employerScope: 'civil-service' }), 'uk', {
        client: db.client,
        fetchBoard: async () => { requests++; return observation(); },
    });
    assert.equal(requests, 1);
    assert.equal(found.boardsChecked, 1);
    assert.equal(found.boardsAvailable, 1);
});

test('punctuation from a student cannot introduce PostgREST operators', async () => {
    const db = mockDb(() => response([]));
    await searchChatEmployerWebJobs(search({ employer: 'Actual),id.gt.0,(Analytics' }), 'uk', {
        client: db.client,
        fetchBoard: async () => {
            throw new Error('must not fetch');
        },
    });
    for (const filter of db.queries[0]!.filters)
        assert.match(filter.value, /^trading_name\.ilike\.%[a-z0-9]+%,companies_house_name\.ilike\.%[a-z0-9]+%$/);
});

test('title and department seed terms are ANDed before a bounded company ID read', async () => {
    const db = mockDb((query) =>
        query.relation === 'companies'
            ? response([company(7)])
            : response([{ company_id: 7 }, { company_id: 7 }, { company_id: 0 }, { company_id: 'not-an-id' }]),
    );
    await searchChatEmployerWebJobs(search(), 'uk', { client: db.client, fetchBoard: async () => observation() });
    assert.equal(db.queries.length, 2);
    assert.deepEqual(db.queries[0]!.filters, [
        { kind: 'or', value: 'title.ilike.%data%,department.ilike.%data%' },
        { kind: 'or', value: 'title.ilike.%analyst%,department.ilike.%analyst%' },
    ]);
    assert.equal(db.queries[0]!.limit, 201);
    assert.deepEqual(db.queries[1]!.filters, [{ kind: 'in', value: 'id', values: [7] }]);
    assert.equal(db.queries[1]!.limit, 101);
});

test('decimal-string catalogue IDs resolve actual employer boards and normalize foreign-key seeds', async () => {
    const db = mockDb((query) =>
        query.relation === 'companies'
            ? response([company(7, { id: '7' })])
            : response([{ company_id: '7' }, { company_id: 7 }]),
    );
    const received: EmployerBoard[] = [];
    const result = await searchChatEmployerWebJobs(search(), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            received.push(board);
            return observation();
        },
    });
    assert.deepEqual(db.queries[1]!.filters, [{ kind: 'in', value: 'id', values: [7] }]);
    assert.equal(result.boardsChecked, 1);
    assert.equal(received[0]!.company!.id, 7);
    assert.equal(received[0]!.token, 'actual-board-7');
});

test('fallback company pool also supports real numeric-string primary keys', async () => {
    const db = mockDb(() => response([company(1, { id: '1' }), company(2, { id: '2' })]));
    const result = await searchChatEmployerWebJobs(search({ role: '', where: 'London' }), 'uk', {
        client: db.client,
        fetchBoard: async () => observation(),
    });
    assert.equal(result.boardsAvailable, 2);
    assert.equal(result.boardsChecked, 2);
});

test('unsafe, fractional, nondecimal and negative IDs never identify employer records', async () => {
    const invalid = [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        '0',
        '-1',
        '1.5',
        '0x10',
        '1e2',
        ' 7 ',
        '',
        '9007199254740992',
    ];
    const db = mockDb(() => response(invalid.map((id) => company(1, { id }))));
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        fetchBoard: async () => {
            throw new Error('must not fetch');
        },
    });
    assert.equal(result.boardsChecked, 0);
    assert.equal(result.boardsAvailable, 0);
});

test('invalid foreign-key IDs do not enter a company ID filter', async () => {
    const db = mockDb((query) =>
        query.relation === 'companies'
            ? response([])
            : response([
                  { company_id: '7' },
                  { company_id: '0x10' },
                  { company_id: '-1' },
                  { company_id: '9007199254740992' },
                  { company_id: '1.5' },
              ]),
    );
    await searchChatEmployerWebJobs(search(), 'uk', { client: db.client, fetchBoard: async () => observation() });
    assert.deepEqual(db.queries[1]!.filters, [{ kind: 'in', value: 'id', values: [7] }]);
});

test('discovery does not apply old location, pay or working arrangement to employer seeds', async () => {
    const db = mockDb((query) =>
        query.relation === 'companies' ? response([company()]) : response([{ company_id: 1 }]),
    );
    await searchChatEmployerWebJobs(
        search({
            where: 'Manchester',
            salary: { min: 40000, currency: 'GBP', period: 'year' },
            workingArrangement: 'remote',
        }),
        'uk',
        { client: db.client, fetchBoard: async () => observation() },
    );
    const filters = JSON.stringify(db.queries[0]!.filters);
    assert.doesNotMatch(filters, /location|Manchester|40000|remote/);
});

test('Ireland uses its own catalogue and suppresses a UK sponsor licence claim', async () => {
    const db = mockDb((query) =>
        query.relation === 'companies'
            ? response([company(1, { ireland_permit_employer: true })])
            : response([{ company_id: 1 }]),
    );
    let received: EmployerBoard | undefined;
    await searchChatEmployerWebJobs(search(), 'ireland', {
        client: db.client,
        fetchBoard: async (board, country) => {
            received = board;
            assert.equal(country, 'ireland');
            return observation();
        },
    });
    assert.equal(db.queries[0]!.relation, 'jobs_IR');
    assert.equal(received!.company!.licensed_sponsor, false);
    assert.equal(received!.company!.ireland_permit_employer, true);
});

test('part-time reads its own job seeds and rejects non-UK requests before querying', async () => {
    const db = mockDb((query) =>
        query.relation === 'companies' ? response([company()]) : response([{ company_id: 1 }]),
    );
    await searchChatEmployerWebJobs(search({ kind: 'part-time' }), 'uk', {
        client: db.client,
        fetchBoard: async () => observation(),
    });
    assert.equal(db.queries[0]!.relation, 'part_time_jobs_UK');
    const queries = db.queries.length;
    await assert.rejects(
        searchChatEmployerWebJobs(search({ kind: 'part-time' }), 'ireland', { client: db.client }),
        ChatLiveWebError,
    );
    assert.equal(db.queries.length, queries);
});

test('an explicit empty named employer never broadens to unrelated fallback companies', async () => {
    const db = mockDb(() => response([]));
    const result = await searchChatEmployerWebJobs(search({ employer: 'Missing Employer' }), 'uk', {
        client: db.client,
        fetchBoard: async () => {
            throw new Error('must not fetch');
        },
    });
    assert.equal(db.queries.length, 1);
    assert.equal(result.boardsChecked, 0);
    assert.equal(result.boardsAvailable, 0);
    assert.deepEqual(result.jobs, []);
});

test('fallback employer pool uses only supported ATS configuration from the catalogue', async () => {
    const db = mockDb((query) => (query.relation === 'companies' ? response([company(3)]) : response([])));
    const result = await searchChatEmployerWebJobs(search(), 'uk', {
        client: db.client,
        fetchBoard: async () => observation(),
    });
    assert.equal(db.queries.length, 2);
    assert.match(db.queries[1]!.filters[0]!.value, /ats_provider\.in\.\(greenhouse,lever,ashby,ashbyhq\)/);
    assert.match(db.queries[1]!.filters[0]!.value, /careers_url\.ilike\.%greenhouse\.io%/);
    assert.equal(result.boardsAvailable, 1);
});

test('unsupported seed boards trigger bounded pool discovery without guessing a company slug', async () => {
    let reads = 0;
    const db = mockDb((query) =>
        query.relation !== 'companies'
            ? response([{ company_id: 1 }])
            : ++reads === 1
              ? response([
                    company(1, {
                        ats_provider: 'unsupported',
                        ats_board_token: null,
                        careers_url: 'https://careers.actualanalytics.com/jobs',
                    }),
                ])
              : response([company(2)]),
    );
    const calls: EmployerBoard[] = [];
    await searchChatEmployerWebJobs(search(), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            calls.push(board);
            return observation();
        },
    });
    assert.equal(db.queries.length, 3);
    assert.deepEqual(
        calls.map((board) => board.token),
        ['actual-board-2'],
    );
});

test('explicit ATS metadata is accepted without a guessed careers URL', async () => {
    const db = mockDb(() =>
        response([company(1, { ats_provider: 'ashbyhq', ats_board_token: 'ActualBoard', careers_url: null })]),
    );
    let received: EmployerBoard | undefined;
    await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics 1' }), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            received = board;
            return observation();
        },
    });
    assert.equal(received!.provider, 'ashby');
    assert.equal(received!.token, 'ActualBoard');
    assert.equal(received!.name, 'Actual Analytics 1');
});

test('regional ATS URLs preserve the actual source region', async () => {
    const db = mockDb(() =>
        response([
            company(1, {
                ats_provider: 'lever',
                ats_board_token: 'actual-board-1',
                careers_url: 'https://jobs.eu.lever.co/actual-board-1',
            }),
        ]),
    );
    let received: EmployerBoard | undefined;
    await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics 1' }), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            received = board;
            return observation();
        },
    });
    assert.equal(received!.region, 'eu');
});

test('real careers URLs identify boards when metadata is absent', async () => {
    const db = mockDb(() =>
        response([
            company(1, {
                ats_provider: null,
                ats_board_token: null,
                careers_url: 'https://jobs.ashbyhq.com/RealBoard',
            }),
        ]),
    );
    let received: EmployerBoard | undefined;
    await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics 1' }), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            received = board;
            return observation();
        },
    });
    assert.equal(received!.provider, 'ashby');
    assert.equal(received!.token, 'RealBoard');
});

test('lookalike ATS hosts and invalid tokens cannot create source requests', async () => {
    const db = mockDb(() =>
        response([
            company(1, {
                ats_provider: null,
                ats_board_token: null,
                careers_url: 'https://jobs.lever.co.attacker.com/RealBoard',
            }),
            company(2, { ats_board_token: '../private', careers_url: null }),
        ]),
    );
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        fetchBoard: async () => {
            throw new Error('must not fetch');
        },
    });
    assert.equal(result.boardsChecked, 0);
});

test('missing optional ATS columns retry SELECT with older fields and retain real URL discovery', async () => {
    const missing = ['ats_provider', 'ats_board_token', 'careers_url', 'ireland_permit_employer'];
    let reads = 0;
    const db = mockDb((query) => {
        const field = missing[reads++];
        if (field) return { data: null, error: { code: '42703', message: `column companies.${field} does not exist` } };
        assert.doesNotMatch(query.columns, /ats_provider|ats_board_token|careers_url|ireland_permit_employer/);
        return response([
            company(1, {
                url: 'https://jobs.lever.co/RealBoard',
                careers_url: undefined,
                ats_provider: undefined,
                ats_board_token: undefined,
            }),
        ]);
    });
    const boards: EmployerBoard[] = [];
    await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics 1' }), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            boards.push(board);
            return observation();
        },
    });
    assert.equal(reads, 5);
    assert.equal(boards[0]!.token, 'RealBoard');
});

test('missing optional columns are also removed from fallback pool filters', async () => {
    let reads = 0;
    const db = mockDb((query) => {
        if (++reads === 1) return { data: null, error: { code: 'PGRST204', message: 'ats_provider is missing' } };
        assert.doesNotMatch(query.columns, /ats_provider/);
        assert.doesNotMatch(query.filters[0]!.value, /ats_provider/);
        return response([company()]);
    });
    const result = await searchChatEmployerWebJobs(search({ role: '', where: 'London' }), 'uk', {
        client: db.client,
        fetchBoard: async () => observation(),
    });
    assert.equal(result.boardsChecked, 1);
    assert.equal(reads, 2);
});

test('unrelated database failures remain unavailable instead of an empty successful search', async () => {
    const db = mockDb(() => ({ data: null, error: { code: '42501', message: 'private project and key details' } }));
    await assert.rejects(
        searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', { client: db.client }),
        (error: unknown) =>
            error instanceof ChatLiveWebError && error.code === 'UNAVAILABLE' && !/private|key/.test(error.message),
    );
    assert.equal(db.queries.length, 1);
});

test('vacancy seed failures remain unavailable without silently broadening catalogue policy', async () => {
    const db = mockDb(() => ({ data: null, error: { code: 'PGRST000', message: 'unavailable' } }));
    await assert.rejects(searchChatEmployerWebJobs(search(), 'uk', { client: db.client }), ChatLiveWebError);
    assert.equal(db.queries.length, 1);
});

test('duplicate supported boards are fetched once', async () => {
    const db = mockDb(() =>
        response([
            company(1),
            company(2, {
                ats_board_token: 'actual-board-1',
                careers_url: 'https://job-boards.greenhouse.io/actual-board-1',
            }),
        ]),
    );
    let calls = 0;
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        fetchBoard: async () => {
            calls++;
            return observation();
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.boardsAvailable, 1);
});

test('six board cap and concurrency three are enforced, with deterministic result order', async () => {
    const db = mockDb(() => response(Array.from({ length: 9 }, (_, index) => company(index + 1))));
    let active = 0;
    let maximum = 0;
    const tokens: string[] = [];
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            active++;
            maximum = Math.max(maximum, active);
            tokens.push(board.token);
            await new Promise((resolve) => setTimeout(resolve, board.token.endsWith('1') ? 5 : 1));
            active--;
            return observation({ jobs: [webJob(board.token)], examined: 1 });
        },
    });
    assert.equal(tokens.length, 6);
    assert.equal(maximum, 3);
    assert.equal(result.boardsChecked, 6);
    assert.equal(result.boardsAvailable, 9);
    assert.equal(result.limitReached, true);
    assert.deepEqual(
        result.jobs.map((job) => job.id),
        Array.from({ length: 6 }, (_, index) => `actual-board-${index + 1}`),
    );
});

test('a caller may raise the board cap to twelve but no higher, reading four boards at a time', async () => {
    const db = mockDb(() => response(Array.from({ length: 20 }, (_, index) => company(index + 1))));
    let active = 0;
    let maximum = 0;
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        maxBoards: 50,
        fetchBoard: async (board) => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active--;
            return observation({ jobs: [webJob(board.token)], examined: 1 });
        },
    });
    assert.equal(result.boardsChecked, 12);
    assert.equal(maximum, 4);
    assert.equal(result.boardsAvailable, 20);
    assert.equal(result.limitReached, true);
});

test('seed and company read bounds mark discovery as partial', async () => {
    const db = mockDb((query) =>
        query.relation !== 'companies'
            ? response(
                  Array.from({ length: 201 }, (_, i) => ({ company_id: i + 1 })),
                  1000,
              )
            : response(Array.from({ length: 101 }, (_, i) => company(i + 1))),
    );
    const result = await searchChatEmployerWebJobs(search(), 'uk', {
        client: db.client,
        fetchBoard: async () => observation(),
    });
    assert.equal(result.limitReached, true);
    assert.equal(result.boardsAvailable, 100);
    assert.equal(db.queries[1]!.filters[0]!.values!.length, 200);
});

test('provider scan bounds and failed board subsets keep successful jobs and mark partial coverage', async () => {
    const db = mockDb(() => response([company(1), company(2), company(3)]));
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            if (board.token.endsWith('2')) throw new Error('private-provider-error');
            return observation({
                jobs: [webJob(board.token)],
                examined: 5,
                excluded: 4,
                limitReached: board.token.endsWith('3'),
            });
        },
    });
    assert.equal(result.jobs.length, 2);
    assert.equal(result.boardsChecked, 3);
    assert.equal(result.boardsFailed, 1);
    assert.equal(result.examined, 10);
    assert.equal(result.excluded, 8);
    assert.equal(result.limitReached, true);
});

test('all board failures produce a sanitized unavailable error', async () => {
    const db = mockDb(() => response([company(1), company(2)]));
    await assert.rejects(
        searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
            client: db.client,
            fetchBoard: async () => {
                throw new Error('secret-provider-URL');
            },
        }),
        (error: unknown) =>
            error instanceof ChatLiveWebError && error.code === 'UNAVAILABLE' && !/secret|URL/.test(error.message),
    );
});

test('a successful empty observation is distinguished from provider failure', async () => {
    const db = mockDb(() => response([company(1), company(2)]));
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        fetchBoard: async (board) => {
            if (board.token.endsWith('2')) throw new Error('unavailable');
            return observation();
        },
    });
    assert.deepEqual(result.jobs, []);
    assert.equal(result.boardsFailed, 1);
    assert.equal(result.boardsChecked, 2);
});

test('same application returned by separate boards is deduplicated with observed counts retained', async () => {
    const db = mockDb(() => response([company(1), company(2)]));
    const result = await searchChatEmployerWebJobs(search({ employer: 'Actual Analytics' }), 'uk', {
        client: db.client,
        now: () => NOW,
        fetchBoard: async () => observation({ jobs: [webJob('same-id')], examined: 1 }),
    });
    assert.equal(result.jobs.length, 1);
    assert.equal(result.examined, 2);
    assert.equal(result.excluded, 1);
    assert.equal(result.retrievedAt, new Date(NOW).toISOString());
    assert.equal(result.cacheHit, false);
});

test('no supported employer boards remains a successful empty bounded search', async () => {
    const db = mockDb(() => response([]));
    const result = await searchChatEmployerWebJobs(search({ role: '', where: 'London' }), 'uk', {
        client: db.client,
        fetchBoard: async () => {
            throw new Error('must not fetch');
        },
    });
    assert.equal(result.boardsChecked, 0);
    assert.equal(result.boardsFailed, 0);
    assert.equal(result.boardsAvailable, 0);
    assert.deepEqual(result.jobs, []);
    assert.equal(result.limitReached, false);
});
