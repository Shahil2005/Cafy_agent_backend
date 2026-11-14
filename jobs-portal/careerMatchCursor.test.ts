import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
    CAREER_CURSOR_MAX_LENGTH,
    CAREER_CURSOR_TTL_MS,
    CareerCursorError,
    careerSubject,
    decryptCareerContext,
    decryptCareerCursor,
    encryptCareerContext,
    encryptCareerCursor,
    newCareerSnapshot,
    type CareerMatchSnapshot,
} from './careerMatchCursor';
import { chatSearchSchema } from './chatIntent';

const NOW = Date.UTC(2026, 9, 28, 12);
const USER = 'fictional-cursor-owner';
const SECRET = 'fictional-server-secret-for-pure-cursor-tests-v1';
const ROTATED_SECRET = 'fictional-server-secret-for-pure-cursor-tests-v2';
const PURPOSE = 'cafy-career-matches:v1';

function snapshot(overrides: Partial<CareerMatchSnapshot> = {}): CareerMatchSnapshot {
    return {
        ...newCareerSnapshot(USER, 'uk', {
            skills: [{ name: 'TypeScript', evidence: 'Built TypeScript applications and tested SQL queries.' }],
            roles: [{ title: 'Software Developer', evidence: 'Software Developer at a fictional employer.' }],
        }, chatSearchSchema.parse({ role: 'software', where: 'Manchester', kind: 'career' }),
        Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), fingerprint: 'a'.repeat(64) })),
        { catalogueScanned: 200, candidates: 80, limitReached: true, sourceFailures: 0 }, NOW),
        ...overrides,
    };
}

function reject(value: unknown, now = NOW): void {
    assert.throws(() => encryptCareerCursor(value as CareerMatchSnapshot, USER, SECRET, now), CareerCursorError);
}

/** Valid AEAD around hostile plaintext verifies the decoder's schema checks, not just its auth tag. */
function sealUnchecked(value: unknown, user = USER): string {
    const iv = randomBytes(12);
    const key = Buffer.from(hkdfSync('sha256', SECRET, PURPOSE, 'encrypted-shortlist-cursor', 32));
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${PURPOSE}:${careerSubject(user)}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

test('encrypted shortlist roundtrips the complete bounded snapshot and saved next offset', () => {
    const original = snapshot({ offset: 5 });
    const token = encryptCareerCursor(original, USER, SECRET, NOW);
    assert.deepEqual(decryptCareerCursor(token, USER, 'uk', SECRET, NOW), original);
    assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('cursor contents conceal CV evidence, preferences and raw user identity', () => {
    const original = snapshot();
    const token = encryptCareerCursor(original, USER, SECRET, NOW);
    const decoded = Buffer.from(token.split('.')[3]!, 'base64url').toString('utf8');
    for (const privateText of [USER, 'TypeScript', 'Manchester', 'fictional employer', original.subject]) {
        assert.equal(token.includes(privateText), false);
        assert.equal(decoded.includes(privateText), false);
    }
    assert.equal(original.subject.includes(USER), false);
    assert.match(original.subject, /^[a-f0-9]{64}$/);
});

test('identical snapshots use independent random nonces but the same explicit key decrypts either', () => {
    const original = snapshot();
    const first = encryptCareerCursor(original, USER, SECRET, NOW);
    const second = encryptCareerCursor(original, USER, SECRET, NOW);
    assert.notEqual(first, second);
    assert.notEqual(first.split('.')[1], second.split('.')[1]);
    assert.deepEqual(decryptCareerCursor(first, USER, 'uk', SECRET, NOW), original);
    assert.deepEqual(decryptCareerCursor(second, USER, 'uk', SECRET, NOW), original);
});

test('tokens are cryptographically bound to their authenticated user and country', () => {
    const token = encryptCareerCursor(snapshot(), USER, SECRET, NOW);
    assert.throws(() => decryptCareerCursor(token, 'another-fictional-user', 'uk', SECRET, NOW), CareerCursorError);
    assert.throws(() => decryptCareerCursor(token, USER, 'ireland', SECRET, NOW), CareerCursorError);
    assert.throws(() => encryptCareerCursor(snapshot(), 'another-fictional-user', SECRET, NOW), CareerCursorError);
    const ireland = snapshot({ country: 'ireland' });
    const irelandToken = encryptCareerCursor(ireland, USER, SECRET, NOW);
    assert.deepEqual(decryptCareerCursor(irelandToken, USER, 'ireland', SECRET, NOW), ireland);
});

test('changing any nonce, auth tag or ciphertext invalidates a cursor', () => {
    const token = encryptCareerCursor(snapshot(), USER, SECRET, NOW);
    for (const index of [1, 2, 3]) {
        const parts = token.split('.');
        const bytes = Buffer.from(parts[index]!, 'base64url');
        bytes[0] = bytes[0]! ^ 1;
        parts[index] = bytes.toString('base64url');
        assert.throws(() => decryptCareerCursor(parts.join('.'), USER, 'uk', SECRET, NOW), CareerCursorError);
    }
});

test('wrong keys fail and key rotation intentionally expires old shortlists', () => {
    const original = snapshot();
    const oldToken = encryptCareerCursor(original, USER, SECRET, NOW);
    assert.throws(() => decryptCareerCursor(oldToken, USER, 'uk', ROTATED_SECRET, NOW), CareerCursorError);
    const newToken = encryptCareerCursor(original, USER, ROTATED_SECRET, NOW);
    assert.deepEqual(decryptCareerCursor(newToken, USER, 'uk', ROTATED_SECRET, NOW), original);
    assert.throws(() => decryptCareerCursor(newToken, USER, 'uk', SECRET, NOW), CareerCursorError);
});

test('short or missing-strength explicit secrets cannot encrypt or decrypt cursors', () => {
    const token = encryptCareerCursor(snapshot(), USER, SECRET, NOW);
    for (const secret of ['', 'a'.repeat(23)]) {
        assert.throws(() => encryptCareerCursor(snapshot(), USER, secret, NOW), CareerCursorError);
        assert.throws(() => decryptCareerCursor(token, USER, 'uk', secret, NOW), CareerCursorError);
    }
});

test('expiry is strict at the exact deadline and never renews through decryption', () => {
    const original = snapshot();
    const token = encryptCareerCursor(original, USER, SECRET, NOW);
    assert.equal(decryptCareerCursor(token, USER, 'uk', SECRET, original.expiresAt - 1).expiresAt, original.expiresAt);
    for (const now of [original.expiresAt, original.expiresAt + 1])
        assert.throws(() => decryptCareerCursor(token, USER, 'uk', SECRET, now), CareerCursorError);
    reject(original, original.expiresAt);
});

test('new snapshots fix the twenty-minute lifetime and do not retain raw resume text', () => {
    const original = snapshot();
    assert.equal(original.issuedAt, NOW);
    assert.equal(original.expiresAt - original.issuedAt, CAREER_CURSOR_TTL_MS);
    assert.equal(CAREER_CURSOR_TTL_MS, 20 * 60_000);
    assert.equal(original.offset, 0);
    assert.equal('resumeText' in original, false);
    assert.equal('resumeName' in original, false);
    assert.equal('userId' in original, false);
});

test('future issuance, reversed lifetime and excessive TTL are rejected', () => {
    for (const change of [
        { issuedAt: NOW + 5001, expiresAt: NOW + CAREER_CURSOR_TTL_MS },
        { issuedAt: NOW + 100, expiresAt: NOW + 100 },
        { issuedAt: NOW + 100, expiresAt: NOW + 99 },
        { expiresAt: NOW + CAREER_CURSOR_TTL_MS + 1 },
        { issuedAt: -1 }, { issuedAt: NOW + 0.5 }, { expiresAt: Number.POSITIVE_INFINITY },
    ]) reject(snapshot(change));
    const tolerated = snapshot({ issuedAt: NOW + 5000, expiresAt: NOW + CAREER_CURSOR_TTL_MS });
    assert.deepEqual(decryptCareerCursor(encryptCareerCursor(tolerated, USER, SECRET, NOW), USER, 'uk', SECRET, NOW), tolerated);
});

test('offsets must be bounded integers within the exact ranked snapshot', () => {
    for (const offset of [-1, 0.5, 13, 121, Number.NaN]) reject(snapshot({ offset }));
    for (const offset of [0, 5, 12]) {
        const original = snapshot({ offset });
        assert.equal(decryptCareerCursor(encryptCareerCursor(original, USER, SECRET, NOW), USER, 'uk', SECRET, NOW).offset, offset);
    }
});

test('ranked snapshots reject duplicate identities, bad fingerprints and more than 120 entries', () => {
    const entries = snapshot().entries;
    reject(snapshot({ entries: [entries[0]!, entries[0]!] }));
    reject(snapshot({ entries: Array.from({ length: 121 }, (_, index) => ({ id: String(index), fingerprint: 'a'.repeat(64) })) }));
    for (const entry of [
        { id: '', fingerprint: 'a'.repeat(64) },
        { id: '1', fingerprint: 'A'.repeat(64) },
        { id: '1', fingerprint: 'a'.repeat(63) },
        { id: '1', fingerprint: 'not-a-fingerprint' },
    ]) reject(snapshot({ entries: [entry] }));
    const maximum = snapshot({ entries: Array.from({ length: 120 }, (_, index) => ({ id: String(index), fingerprint: 'a'.repeat(64) })), offset: 120 });
    assert.equal(decryptCareerCursor(encryptCareerCursor(maximum, USER, SECRET, NOW), USER, 'uk', SECRET, NOW).entries.length, 120);
});

test('profile, criteria and coverage limits are enforced before encryption', () => {
    const base = snapshot();
    for (const profile of [
        { ...base.profile, skills: [] },
        { ...base.profile, skills: Array.from({ length: 25 }, () => base.profile.skills[0]!) },
        { ...base.profile, skills: [{ name: 'x'.repeat(81), evidence: 'TypeScript' }] },
        { ...base.profile, skills: [{ name: 'TypeScript', evidence: 'x'.repeat(181) }] },
        { ...base.profile, roles: Array.from({ length: 4 }, () => base.profile.roles[0]!) },
    ]) reject(snapshot({ profile }));
    for (const coverage of [
        { ...base.coverage, catalogueScanned: 100001 }, { ...base.coverage, catalogueScanned: -1 },
        { ...base.coverage, candidates: 121 }, { ...base.coverage, sourceFailures: 11 },
        { ...base.coverage, candidates: 0.5 },
    ]) reject(snapshot({ coverage }));
    reject({ ...base, search: { ...base.search, role: 'a'.repeat(101) } });
});

test('unknown fields cannot smuggle raw CV or reusable records into cursor snapshots', () => {
    const base = snapshot();
    for (const value of [
        { ...base, resumeText: 'private resume text' },
        { ...base, profile: { ...base.profile, fullResume: 'private resume text' } },
        { ...base, entries: [{ ...base.entries[0], description: 'copied advert' }] },
        { ...base, coverage: { ...base.coverage, debugUrl: 'https://private.cafy-fictional.com' } },
        { ...base, search: { ...base.search, privileged: true } },
    ]) reject(value);
});

test('decoder checks schema and cross-field invariants even for correctly authenticated ciphertext', () => {
    const base = snapshot();
    for (const value of [
        { ...base, version: 2 }, { ...base, subject: careerSubject('someone-else') },
        { ...base, country: 'ireland' }, { ...base, offset: 13 },
        { ...base, entries: [base.entries[0], base.entries[0]] },
        { ...base, expiresAt: NOW + CAREER_CURSOR_TTL_MS + 1 },
        { ...base, fullResume: 'unexpected private data' }, null, [], 'snapshot',
    ]) {
        const token = sealUnchecked(value);
        assert.throws(() => decryptCareerCursor(token, USER, 'uk', SECRET, NOW), CareerCursorError);
    }
});

test('malformed, unsupported-version and oversized tokens use the same bounded safe error', () => {
    const valid = encryptCareerCursor(snapshot(), USER, SECRET, NOW);
    for (const token of [
        '', 'v1', 'v2' + valid.slice(2), valid + '.extra', valid + '=',
        valid.replace(/^v1\./, 'v1..'), valid.replace(/\./, ' '),
        valid.replace(/[A-Za-z0-9_-]$/, '+'), 'x'.repeat(CAREER_CURSOR_MAX_LENGTH + 1),
    ]) assert.throws(() => decryptCareerCursor(token, USER, 'uk', SECRET, NOW), (error: unknown) => {
        assert.ok(error instanceof CareerCursorError);
        if (token) assert.equal(error.message.includes(token), false);
        assert.match(error.message, /expired or changed/);
        return true;
    });
});

test('noncanonical base64url aliases are rejected even when they decode to identical bytes', () => {
    const token = encryptCareerCursor(snapshot(), USER, SECRET, NOW);
    const parts = token.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const tag = parts[2]!;
    const final = alphabet.indexOf(tag.slice(-1));
    const alias = tag.slice(0, -1) + alphabet[final + 1];
    assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(tag, 'base64url'));
    parts[2] = alias;
    assert.throws(() => decryptCareerCursor(parts.join('.'), USER, 'uk', SECRET, NOW), CareerCursorError);
});

test('replaying a valid cursor is deterministic and does not consume or mutate hidden server state', () => {
    const original = snapshot({ offset: 5 });
    const before = JSON.stringify(original);
    const token = encryptCareerCursor(original, USER, SECRET, NOW);
    const first = decryptCareerCursor(token, USER, 'uk', SECRET, NOW);
    first.offset = 10;
    first.profile.skills[0]!.name = 'Changed only in this local object';
    const second = decryptCareerCursor(token, USER, 'uk', SECRET, NOW + 1000);
    assert.deepEqual(second, original);
    assert.equal(JSON.stringify(original), before);
    assert.equal(second.offset, 5);
});

test('encrypted context retains the verified profile, conversation state and consumed next-five offset', () => {
    const original = snapshot({ offset: 5, state: 'results' });
    const token = encryptCareerContext(original, USER, SECRET, NOW);
    assert.match(token, /^c1\./);
    assert.deepEqual(decryptCareerContext(token, USER, 'uk', SECRET, NOW), original);
    for (const secretText of ['TypeScript', 'Manchester', USER, 'Software Developer'])
        assert.equal(token.includes(secretText), false);
});

test('profile contexts and next-page tokens have separate cryptographic purposes even if their prefixes are changed', () => {
    const original = snapshot({ offset: 5 });
    const context = encryptCareerContext(original, USER, SECRET, NOW);
    const page = encryptCareerCursor(original, USER, SECRET, NOW);
    assert.throws(() => decryptCareerCursor(context, USER, 'uk', SECRET, NOW), CareerCursorError);
    assert.throws(() => decryptCareerContext(page, USER, 'uk', SECRET, NOW), CareerCursorError);
    assert.throws(() => decryptCareerCursor(`v1${context.slice(2)}`, USER, 'uk', SECRET, NOW), CareerCursorError);
    assert.throws(() => decryptCareerContext(`c1${page.slice(2)}`, USER, 'uk', SECRET, NOW), CareerCursorError);
});

test('profile contexts enforce the same owner, country, key rotation and original deadline checks', () => {
    const original = snapshot({ state: 'needs-clarification', offset: 5 });
    const token = encryptCareerContext(original, USER, SECRET, NOW);
    for (const [user, country, secret, now] of [
        ['another-user', 'uk', SECRET, NOW], [USER, 'ireland', SECRET, NOW],
        [USER, 'uk', ROTATED_SECRET, NOW], [USER, 'uk', SECRET, original.expiresAt],
    ] as const)
        assert.throws(() => decryptCareerContext(token, user, country, secret, now), CareerCursorError);
});
