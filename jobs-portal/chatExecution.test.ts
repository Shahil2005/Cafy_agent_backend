import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { ReadableStream } from 'node:stream/web';
import {
    createChatCatalogueReadOnlyFetch,
    searchChatCatalogue,
} from './chatCatalogue';
import {
    createChatExecution,
    ChatExecutionError,
    type ChatExecutionErrorKind,
} from './chatExecution';
import { chatSearchSchema } from './chatIntent';

const kind =
    (expected: ChatExecutionErrorKind) =>
    (error: unknown): boolean =>
        error instanceof ChatExecutionError &&
        error.kind === expected &&
        !error.message.includes('private');

test('request execution defaults to sixty seconds and caps explicitly larger budgets at two minutes', () => {
    const normal = createChatExecution();
    const bounded = createChatExecution({ timeoutMs: 999_999 });
    const invalid = createChatExecution({ timeoutMs: NaN });
    try {
        assert.ok(
            normal.remainingMs() > 59_000 && normal.remainingMs() <= 60_000,
        );
        assert.ok(
            bounded.remainingMs() > 119_000 && bounded.remainingMs() <= 120_000,
        );
        assert.ok(
            invalid.remainingMs() > 59_000 && invalid.remainingMs() <= 60_000,
        );
    } finally {
        normal.cleanup();
        bounded.cleanup();
        invalid.cleanup();
    }
});

test('successful tasks preserve their result and release per-run listeners', async () => {
    const parent = new AbortController();
    const budget = createChatExecution({
        signal: parent.signal,
        timeoutMs: 1000,
    });
    const value = { verified: true };
    try {
        assert.equal(await budget.run(async () => value), value);
        assert.equal(getEventListeners(budget.signal, 'abort').length, 0);
    } finally {
        budget.cleanup();
    }
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
    assert.equal(budget.signal.aborted, true);
    assert.equal(parent.signal.aborted, false);
    budget.cleanup();
});

test('zero or already cancelled budgets do not execute a task', async () => {
    const parent = new AbortController();
    parent.abort();
    let calls = 0;
    for (const [budget, expected] of [
        [createChatExecution({ timeoutMs: 0 }), 'timeout'],
        [createChatExecution({ timeoutMs: -1 }), 'timeout'],
        [createChatExecution({ signal: parent.signal }), 'cancelled'],
    ] as const) {
        try {
            await assert.rejects(
                budget.run(async () => {
                    calls++;
                    return true;
                }),
                kind(expected),
            );
            assert.equal(budget.remainingMs(), 0);
        } finally {
            budget.cleanup();
        }
    }
    assert.equal(calls, 0);
});

test('a real request deadline rejects work even when it ignores the abort signal', async () => {
    const parent = new AbortController();
    const budget = createChatExecution({
        signal: parent.signal,
        timeoutMs: 20,
    });
    const started = Date.now();
    try {
        await assert.rejects(
            budget.run(() => new Promise<never>(() => {})),
            kind('timeout'),
        );
        assert.equal(budget.signal.aborted, true);
        assert.equal(budget.remainingMs(), 0);
        assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
        assert.equal(getEventListeners(budget.signal, 'abort').length, 0);
        assert.ok(Date.now() - started < 1000);
    } finally {
        budget.cleanup();
    }
});

test('parent cancellation rejects every active task and removes the shared listener', async () => {
    const parent = new AbortController();
    const budget = createChatExecution({
        signal: parent.signal,
        timeoutMs: 1000,
    });
    const first = budget.run(() => new Promise<never>(() => {}));
    const second = budget.run(() => new Promise<never>(() => {}));
    parent.abort(new Error('private request detail'));
    await Promise.all([
        assert.rejects(first, kind('cancelled')),
        assert.rejects(second, kind('cancelled')),
    ]);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
    assert.equal(getEventListeners(budget.signal, 'abort').length, 0);
    budget.cleanup();
});

test('cleanup cancels outstanding work and future run calls without resetting the deadline', async () => {
    const budget = createChatExecution({ timeoutMs: 1000 });
    const active = budget.run(() => new Promise<never>(() => {}));
    budget.cleanup();
    budget.cleanup();
    await assert.rejects(active, kind('cancelled'));
    let calls = 0;
    await assert.rejects(
        budget.run(async () => {
            calls++;
            return true;
        }),
        kind('cancelled'),
    );
    assert.equal(calls, 0);
});

test('later tasks share the original deadline rather than receiving another full budget', async () => {
    const budget = createChatExecution({ timeoutMs: 35 });
    const original = budget.remainingMs();
    try {
        await budget.run(
            () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
        );
        assert.ok(budget.remainingMs() < original);
        await assert.rejects(
            budget.run(() => new Promise<never>(() => {})),
            kind('timeout'),
        );
    } finally {
        budget.cleanup();
    }
});

test('late task rejection after cancellation is consumed without an unhandled rejection', async () => {
    const parent = new AbortController();
    const budget = createChatExecution({
        signal: parent.signal,
        timeoutMs: 1000,
    });
    let rejectTask: (error: Error) => void = () => {};
    const active = budget.run(
        () =>
            new Promise<never>((_resolve, reject) => {
                rejectTask = reject;
            }),
    );
    parent.abort();
    await assert.rejects(active, kind('cancelled'));
    rejectTask(new Error('private late provider error'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    budget.cleanup();
});

test('ordinary task failures keep their original error while releasing listeners', async () => {
    const budget = createChatExecution({ timeoutMs: 1000 });
    const original = new Error('ordinary task failure');
    try {
        await assert.rejects(
            budget.run(async () => {
                throw original;
            }),
            (error: unknown) => error === original,
        );
        await assert.rejects(
            budget.run(() => {
                throw original;
            }),
            (error: unknown) => error === original,
        );
        assert.equal(getEventListeners(budget.signal, 'abort').length, 0);
    } finally {
        budget.cleanup();
    }
});

test('the catalogue transport rejects every mutation method before fetch', async () => {
    let calls = 0;
    const read = createChatCatalogueReadOnlyFetch({
        fetch: async () => {
            calls++;
            return new Response('{}');
        },
    });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
        await assert.rejects(
            read('https://catalogue.example.co.uk/rest/v1/jobs', { method }),
            /SELECT requests only/,
        );
    await assert.rejects(
        read(
            new Request('https://catalogue.example.co.uk/rest/v1/jobs', {
                method: 'POST',
            }),
        ),
        /SELECT requests only/,
    );
    assert.equal(calls, 0);
});

test('the catalogue transport preserves SELECT data, status and range headers after a bounded body read', async () => {
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const read = createChatCatalogueReadOnlyFetch({
        signal: parent.signal,
        fetch: async (_input, init) => {
            receivedSignal = init?.signal ?? undefined;
            return Response.json([{ id: 'source-record' }], {
                status: 206,
                headers: {
                    'content-range': '0-0/12',
                    'content-encoding': 'gzip',
                    'content-length': '99',
                },
            });
        },
    });
    const response = await read(
        'https://catalogue.example.co.uk/rest/v1/jobs',
        { method: 'GET' },
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), '0-0/12');
    assert.equal(response.headers.get('content-encoding'), null);
    assert.deepEqual(await response.json(), [{ id: 'source-record' }]);
    assert.equal(receivedSignal?.aborted, true);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('the catalogue transport supports HEAD and bodyless SELECT responses', async () => {
    for (const [method, status] of [
        ['HEAD', 200],
        ['GET', 204],
    ] as const) {
        const read = createChatCatalogueReadOnlyFetch({
            fetch: async () =>
                new Response(null, {
                    status,
                    headers: { 'content-range': '*/12' },
                }),
        });
        const response = await read(
            'https://catalogue.example.co.uk/rest/v1/jobs',
            { method },
        );
        assert.equal(response.status, status);
        assert.equal(response.headers.get('content-range'), '*/12');
        assert.equal(await response.text(), '');
    }
});

test('already aborted parent, Request or SDK signals prevent catalogue fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetcher: typeof globalThis.fetch = async () => {
        calls++;
        return new Response('{}');
    };
    await assert.rejects(
        createChatCatalogueReadOnlyFetch({
            signal: controller.signal,
            fetch: fetcher,
        })('https://catalogue.example.co.uk/rest/v1/jobs'),
        kind('cancelled'),
    );
    await assert.rejects(
        createChatCatalogueReadOnlyFetch({ fetch: fetcher })(
            'https://catalogue.example.co.uk/rest/v1/jobs',
            { signal: controller.signal },
        ),
        kind('cancelled'),
    );
    await assert.rejects(
        createChatCatalogueReadOnlyFetch({ fetch: fetcher })(
            new Request('https://catalogue.example.co.uk/rest/v1/jobs', {
                signal: controller.signal,
            }),
        ),
        kind('cancelled'),
    );
    assert.equal(calls, 0);
});

test('parent cancellation interrupts a stalled catalogue fetch and cleans all input listeners', async () => {
    const parent = new AbortController();
    const sdk = new AbortController();
    let passedSignal: AbortSignal | undefined;
    const read = createChatCatalogueReadOnlyFetch({
        signal: parent.signal,
        fetch: async (_input, init) => {
            passedSignal = init?.signal ?? undefined;
            return new Promise<Response>(() => {});
        },
    });
    const active = read('https://catalogue.example.co.uk/rest/v1/jobs', {
        signal: sdk.signal,
    });
    parent.abort();
    await assert.rejects(active, kind('cancelled'));
    assert.equal(passedSignal?.aborted, true);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
    assert.equal(getEventListeners(sdk.signal, 'abort').length, 0);
});

test('the per-SELECT deadline covers a response whose body stalls after headers', async () => {
    let cancelled = 0;
    const read = createChatCatalogueReadOnlyFetch({
        timeoutMs: 20,
        fetch: async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('['));
                    },
                    cancel() {
                        cancelled++;
                    },
                }),
            ),
    });
    await assert.rejects(
        read('https://catalogue.example.co.uk/rest/v1/jobs'),
        kind('timeout'),
    );
    assert.equal(cancelled, 1);
});

test('oversized catalogue bodies fail without retaining or returning their content', async () => {
    let cancelled = 0;
    const advertised = createChatCatalogueReadOnlyFetch({
        fetch: async () =>
            new Response(
                new ReadableStream({
                    cancel() {
                        cancelled++;
                    },
                }),
                { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } },
            ),
    });
    await assert.rejects(
        advertised('https://catalogue.example.co.uk/rest/v1/jobs'),
        /response is too large/,
    );
    assert.equal(cancelled, 1);
    const streamed = createChatCatalogueReadOnlyFetch({
        fetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    });
    await assert.rejects(
        streamed('https://catalogue.example.co.uk/rest/v1/jobs'),
        /response is too large/,
    );
});

test('an already cancelled catalogue search never calls an injected client', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = {
        from: () => {
            calls++;
            throw new Error('must not read');
        },
    };
    await assert.rejects(
        searchChatCatalogue(
            chatSearchSchema.parse({
                role: 'analyst',
                where: '',
                kind: 'career',
            }),
            'uk',
            undefined,
            {
                client: client as never,
                signal: controller.signal,
            },
        ),
        kind('cancelled'),
    );
    assert.equal(calls, 0);
});
