import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { createCareerMatchHandler } from './careerMatchHandler';
import { CareerCursorError } from './careerMatchCursor';
import { CareerProfileError } from './careerMatchProfile';
import { CareerMatchError } from './careerMatchService';
import type { CareerMatchContext } from './careerMatchService';
import type { CareerMatchResponse } from './careerMatchTypes';
import { chatSearchSchema } from './chatIntent';

const cv = 'PRIVATE-CV-SENTINEL Software Engineer. Built Python projects and reporting systems. Strong testing and documentation skills.';
const context: CareerMatchContext = { userId: 'student', country: 'uk', careerPremium: true, partTimePremium: false, partTimeBlocked: false };
const output: CareerMatchResponse = {
    state: 'needs-role', contextCursor: 'c1.mocked-encrypted-context-for-isolated-handler-tests',
    profile: { skills: [{ name: 'Python', evidence: 'Built Python projects' }], roles: [] },
    search: chatSearchSchema.parse({ role: '', where: '', kind: 'career' }),
    jobs: [], batchSize: 5, hasMore: false, pageId: 'a'.repeat(64),
    coverage: { catalogueScanned: 0, candidates: 0, limitReached: false, sourceFailures: 0 },
    message: 'Choose a target role.',
};
function http(body: unknown = { resumeText: cv }, uid: string | null = 'student') {
    const req = Object.assign(new EventEmitter(), { body, user: uid ? { uid } : undefined });
    let status = 0; let json: unknown;
    const headers: Record<string, string> = {};
    const res = Object.assign(new EventEmitter(), {
        writableEnded: false, destroyed: false,
        setHeader: (name: string, value: string) => { headers[name] = value; },
        status: (code: number) => { status = code; return res; },
        json: (value: unknown) => { json = value; res.writableEnded = true; return res; },
    });
    return { req, res, request: req as unknown as Request, response: res as unknown as Response,
        result: () => ({ status, json, headers }) };
}

test('matching handler requires authentication before reading profiles or sending CV data', async () => {
    let calls = 0; const f = http(undefined, null);
    await createCareerMatchHandler({ context: async () => { calls++; return context; } })(f.request, f.response);
    assert.equal(f.result().status, 401); assert.equal(calls, 0);
    assert.equal(f.result().headers['Cache-Control'], 'no-store');
});

test('invalid or oversized requests are rejected without echoing the CV or reading the user', async () => {
    for (const body of [{ resumeText: cv, guessedJobs: [] }, { resumeText: 'x'.repeat(40_001) }, { cursor: 'invalid' }]) {
        let calls = 0; const f = http(body);
        await createCareerMatchHandler({ context: async () => { calls++; return context; } })(f.request, f.response);
        assert.equal(f.result().status, 400); assert.equal(calls, 0);
        assert.doesNotMatch(JSON.stringify(f.result().json), /PRIVATE-CV-SENTINEL/);
    }
});

test('authenticated matching invokes only injected read context and pure engine with cancellation signal', async () => {
    const f = http(); let calls = 0;
    await createCareerMatchHandler({
        context: async (uid) => { assert.equal(uid, 'student'); return context; },
        run: async (input, received, deps) => {
            calls++; assert.deepEqual(input, { resumeText: cv }); assert.deepEqual(received, context);
            assert.ok(deps?.signal); assert.equal(deps.signal.aborted, false);
            return output;
        },
    })(f.request, f.response);
    assert.equal(calls, 1); assert.equal(f.result().status, 200); assert.deepEqual(f.result().json, output);
    assert.equal(f.req.listenerCount('aborted'), 0); assert.equal(f.res.listenerCount('close'), 0);
});

test('authenticated conversation refinements pass only the bounded message and encrypted context to the engine', async () => {
    const body = { contextCursor: 'c1.mocked-encrypted-context-for-isolated-handler-tests', message: 'frontend developer in London' };
    const f = http(body); let calls = 0;
    await createCareerMatchHandler({ context: async () => context,
        run: async (input) => { calls++; assert.deepEqual(input, body); return output; },
    })(f.request, f.response);
    assert.equal(f.result().status, 200); assert.equal(calls, 1);
    assert.deepEqual(f.result().json, output);
});

test('a mismatched profile identity fails before the engine and exposes no private exception data', async () => {
    const f = http(); let calls = 0;
    await createCareerMatchHandler({ context: async () => ({ ...context, userId: 'other-student' }),
        run: async () => { calls++; return output; } })(f.request, f.response);
    assert.equal(f.result().status, 503); assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(f.result().json), /other-student|identity mismatch|PRIVATE-CV/);
});

test('expired cursor, plan, unsupported filter and unavailable catalogue have distinct safe status codes', async () => {
    for (const [error, status] of [
        [new CareerCursorError(), 409],
        [new CareerMatchError('PLAN_REQUIRED', 'A jobs plan is required.'), 403],
        [new CareerMatchError('UNSUPPORTED_FILTERS', 'Clarify the filters.'), 400],
        [new CareerMatchError('CATALOGUE_UNAVAILABLE', 'The catalogue is unavailable.'), 503],
    ] as const) {
        const f = http();
        await createCareerMatchHandler({ context: async () => context, run: async () => { throw error; } })(f.request, f.response);
        assert.equal(f.result().status, status);
    }
});

test('provider failure and an unusable CV are distinguishable without arbitrary provider text', async () => {
    for (const [error, status] of [
        [new CareerProfileError('PROFILE_UNAVAILABLE', 'CV analysis is temporarily unavailable.'), 503],
        [new CareerProfileError('PROFILE_UNSUPPORTED', 'Choose a clearer CV.'), 422],
    ] as const) {
        const f = http();
        await createCareerMatchHandler({ context: async () => context, run: async () => { throw error; } })(f.request, f.response);
        assert.equal(f.result().status, status);
    }
    const f = http();
    await createCareerMatchHandler({ context: async () => context, run: async () => { throw new Error('PRIVATE-CV-SENTINEL provider-secret'); } })(f.request, f.response);
    assert.equal(f.result().status, 503);
    assert.doesNotMatch(JSON.stringify(f.result().json), /PRIVATE-CV|provider-secret/);
});

test('the shared deadline prevents a late profile read from starting AI or catalogue work', async () => {
    const f = http(); let calls = 0;
    await createCareerMatchHandler({ timeoutMs: 5,
        context: async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return context; },
        run: async () => { calls++; return output; },
    })(f.request, f.response);
    assert.equal(f.result().status, 503); assert.equal(calls, 0);
    assert.match(JSON.stringify(f.result().json), /MATCH_TIMEOUT/);
});

test('disconnect aborts pending work and cannot publish a late result', async () => {
    const f = http(); let calls = 0;
    const promise = createCareerMatchHandler({
        context: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return context; },
        run: async () => { calls++; return output; },
    })(f.request, f.response);
    f.req.emit('aborted'); await promise;
    assert.equal(f.result().json, undefined); assert.equal(calls, 0);
    assert.equal(f.req.listenerCount('aborted'), 0);
});

test('Google discovery can be disabled or injected without the handler calling it itself', async () => {
    const disabled = http(); let seen: unknown = 'unset';
    await createCareerMatchHandler({ context: async () => context, groundedSearch: null,
        run: async (_input, _received, deps) => { seen = deps?.groundedSearch; return output; },
    })(disabled.request, disabled.response);
    assert.equal(disabled.result().status, 200); assert.equal(seen, undefined);
    let googleCalls = 0;
    const injected = async () => { googleCalls++; throw new Error('must only be forwarded'); };
    const forwarded = http();
    await createCareerMatchHandler({ context: async () => context, groundedSearch: injected,
        run: async (_input, _received, deps) => { seen = deps?.groundedSearch; return output; },
    })(forwarded.request, forwarded.response);
    assert.equal(forwarded.result().status, 200); assert.equal(seen, injected); assert.equal(googleCalls, 0);
});

test('fit scoring can be disabled or injected without the handler calling it itself', async () => {
    const disabled = http(); let seen: unknown = 'unset';
    await createCareerMatchHandler({ context: async () => context, groundedSearch: null, assessFit: null,
        run: async (_input, _received, deps) => { seen = deps?.assessFit; return output; },
    })(disabled.request, disabled.response);
    assert.equal(disabled.result().status, 200); assert.equal(seen, undefined);
    let fitCalls = 0;
    const injected = async () => { fitCalls++; throw new Error('must only be forwarded'); };
    const forwarded = http();
    await createCareerMatchHandler({ context: async () => context, groundedSearch: null, assessFit: injected,
        run: async (_input, _received, deps) => { seen = deps?.assessFit; return output; },
    })(forwarded.request, forwarded.response);
    assert.equal(forwarded.result().status, 200); assert.equal(seen, injected); assert.equal(fitCalls, 0);
});
