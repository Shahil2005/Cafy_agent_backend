import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGenerationConfig, getGeminiProfile } from '../ai/profiles';
import { parseSecureInput } from '../ai/parseSecureInput';

test('whole-CV extraction has its own bounded JSON operation without search tools', () => {
    const profile = getGeminiProfile('jobs_cv_profile');
    assert.equal(profile.temperature, 0); assert.equal(profile.maxOutputTokens, 4096);
    assert.equal(profile.jsonOutput, true); assert.equal(profile.tools, undefined);
    assert.equal(getGeminiProfile('jobs_search_chat').maxOutputTokens, 1024);
    const config = buildGenerationConfig('jobs_cv_profile', { model: 'gemini-2.5-flash' });
    assert.equal(config.responseMimeType, 'application/json');
    assert.deepEqual(config.thinkingConfig, { thinkingBudget: 0 });
});

test('the CV operation cannot bypass the dedicated authenticated route through generic generation', () => {
    const parsed = parseSecureInput({ operation: 'jobs_cv_profile', input: { resumeText: 'fictional' } });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
        assert.equal(parsed.error, 'DIRECT_ROUTE_REQUIRED');
        assert.match(parsed.message, /career-matches/);
    }
});

test('fit judgement is a deterministic JSON operation reachable only through the career-matches route', () => {
    const profile = getGeminiProfile('jobs_cv_fit');
    assert.equal(profile.temperature, 0); assert.equal(profile.maxOutputTokens, 4096);
    assert.equal(profile.jsonOutput, true); assert.equal(profile.tools, undefined);
    const parsed = parseSecureInput({ operation: 'jobs_cv_fit', input: { adverts: [] } });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
        assert.equal(parsed.error, 'DIRECT_ROUTE_REQUIRED');
        assert.match(parsed.message, /jobs_cv_fit.*career-matches/);
    }
});

test('role-family expansion is a small deterministic JSON operation reachable only through the career-matches route', () => {
    const profile = getGeminiProfile('jobs_cv_roles');
    assert.equal(profile.temperature, 0); assert.equal(profile.maxOutputTokens, 512);
    assert.equal(profile.jsonOutput, true); assert.equal(profile.tools, undefined);
    const parsed = parseSecureInput({ operation: 'jobs_cv_roles', input: { request: 'developer' } });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
        assert.equal(parsed.error, 'DIRECT_ROUTE_REQUIRED');
        assert.match(parsed.message, /jobs_cv_roles.*career-matches/);
    }
});
