import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getGeminiApiKey } from '../ai/config';
import { chatSearchSchema } from './chatIntent';
import { careerProfileSchema } from './careerMatchProfile';
import { storedCareerFitSchema } from './careerMatchFit';
import { CAREER_MATCH_STATES, type CareerMatchCoverage, type CareerProfile } from './careerMatchTypes';
import { careerWebReferenceSchema } from './careerMatchWeb';

export const CAREER_CURSOR_TTL_MS = 20 * 60_000;
export const CAREER_CURSOR_MAX_LENGTH = 120_000;
const PURPOSE = 'cafy-career-matches:v1';
const snapshotSchema = z.object({
    version: z.literal(1),
    subject: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    country: z.enum(['uk', 'ireland']),
    search: chatSearchSchema,
    profile: careerProfileSchema,
    /** Preserve clarification/outage state when a conversational follow-up says “more”. */
    state: z.enum(CAREER_MATCH_STATES).optional(),
    webEnabled: z.boolean().optional(),
    /** Google was already tried for this search. A flag only: no Google content enters the token. */
    groundedChecked: z.boolean().optional(),
    /** Equivalent titles for the explicit role, first entry the role itself, so pages stay consistent. */
    roleTitles: z.array(z.string().trim().min(2).max(80).regex(/^[^<>{}[\]@]+$/)).min(1).max(8).optional(),
    entries: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        /** Canonical application identity permits late native discovery without repeating consumed jobs. */
        urlHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        webReference: careerWebReferenceSchema.optional(),
        /** Verified fit judgements for a scored but not yet shown advert, re-checked on reuse. */
        fit: storedCareerFitSchema.optional() }).strict()).max(120),
    offset: z.number().int().min(0).max(120),
    coverage: z.object({
        catalogueScanned: z.number().int().nonnegative().max(100_000),
        candidates: z.number().int().nonnegative().max(120),
        limitReached: z.boolean(),
        sourceFailures: z.number().int().nonnegative().max(10),
        catalogueStatus: z.enum(['checked', 'unavailable']).optional(),
        web: z.object({
            examined: z.number().int().nonnegative().max(100_000),
            candidates: z.number().int().nonnegative().max(60),
            sourcesChecked: z.number().int().min(0).max(2),
            sourcesFailed: z.number().int().min(0).max(2),
            sourcesAvailable: z.number().int().min(0).max(2),
            limitReached: z.boolean(),
        }).strict().optional(),
    }).strict(),
}).strict();

export type CareerMatchSnapshot = z.infer<typeof snapshotSchema>;
export class CareerCursorError extends Error {
    constructor() { super('This shortlist has expired or changed. Analyse your CV again to start a fresh search.'); }
}

/** A dedicated key is preferred. Existing server-only AI credentials provide a domain-separated fallback. */
export function careerCursorSecret(): string | undefined {
    return process.env.CAREER_MATCH_CURSOR_SECRET?.trim() || getGeminiApiKey('jobs_search_chat');
}

export function careerSubject(userId: string): string {
    return createHash('sha256').update(`${PURPOSE}:user:${userId}`).digest('hex');
}

type CursorPurpose = 'shortlist' | 'context';

function key(secret: string, purpose: CursorPurpose): Buffer {
    if (secret.length < 24) throw new CareerCursorError();
    return Buffer.from(hkdfSync('sha256', secret, PURPOSE, `encrypted-${purpose}-cursor`, 32));
}

function associatedData(userId: string, purpose: CursorPurpose): Buffer {
    return Buffer.from(purpose === 'shortlist'
        ? `${PURPOSE}:${careerSubject(userId)}`
        : `${PURPOSE}:profile-context:${careerSubject(userId)}`);
}

function checked(value: unknown, userId: string, country: 'uk' | 'ireland', now: number): CareerMatchSnapshot {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) throw new CareerCursorError();
    const data = parsed.data;
    if (data.subject !== careerSubject(userId) || data.country !== country ||
        data.issuedAt > now + 5_000 || data.expiresAt <= now ||
        data.expiresAt <= data.issuedAt || data.expiresAt - data.issuedAt > CAREER_CURSOR_TTL_MS ||
        data.offset > data.entries.length || new Set(data.entries.map((entry) => entry.id)).size !== data.entries.length)
        throw new CareerCursorError();
    return data;
}

function encryptSnapshot(snapshot: CareerMatchSnapshot, userId: string, secret: string, now: number, purpose: CursorPurpose): string {
    const data = checked(snapshot, userId, snapshot.country, now);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(secret, purpose), iv);
    cipher.setAAD(associatedData(userId, purpose));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const token = [purpose === 'shortlist' ? 'v1' : 'c1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
    if (token.length > CAREER_CURSOR_MAX_LENGTH) throw new CareerCursorError();
    return token;
}

function decryptSnapshot(token: string, userId: string, country: 'uk' | 'ireland', secret: string, now: number, purpose: CursorPurpose): CareerMatchSnapshot {
    try {
        const shape = purpose === 'shortlist'
            ? /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/
            : /^c1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/;
        if (token.length > CAREER_CURSOR_MAX_LENGTH || !shape.test(token))
            throw new CareerCursorError();
        const [, encodedIv, encodedTag, encodedData] = token.split('.');
        const iv = Buffer.from(encodedIv!, 'base64url');
        const tag = Buffer.from(encodedTag!, 'base64url');
        const encrypted = Buffer.from(encodedData!, 'base64url');
        if (iv.toString('base64url') !== encodedIv || tag.toString('base64url') !== encodedTag ||
            encrypted.toString('base64url') !== encodedData || encrypted.length > 90_000)
            throw new CareerCursorError();
        const decipher = createDecipheriv('aes-256-gcm', key(secret, purpose), iv);
        decipher.setAAD(associatedData(userId, purpose));
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const snapshot = checked(JSON.parse(plain.toString('utf8')), userId, country, now);
        return snapshot;
    } catch { throw new CareerCursorError(); }
}

export function encryptCareerCursor(snapshot: CareerMatchSnapshot, userId: string, secret: string, now = Date.now()): string {
    return encryptSnapshot(snapshot, userId, secret, now, 'shortlist');
}

export function decryptCareerCursor(token: string, userId: string, country: 'uk' | 'ireland', secret: string, now = Date.now()): CareerMatchSnapshot {
    return decryptSnapshot(token, userId, country, secret, now, 'shortlist');
}

/** Separate AEAD purpose prevents a profile context from acting as a pagination token. */
export function encryptCareerContext(snapshot: CareerMatchSnapshot, userId: string, secret: string, now = Date.now()): string {
    return encryptSnapshot(snapshot, userId, secret, now, 'context');
}

export function decryptCareerContext(token: string, userId: string, country: 'uk' | 'ireland', secret: string, now = Date.now()): CareerMatchSnapshot {
    return decryptSnapshot(token, userId, country, secret, now, 'context');
}

export function newCareerSnapshot(
    userId: string,
    country: 'uk' | 'ireland',
    profile: CareerProfile,
    search: CareerMatchSnapshot['search'],
    entries: CareerMatchSnapshot['entries'],
    coverage: CareerMatchCoverage,
    now = Date.now(),
): CareerMatchSnapshot {
    return checked({ version: 1, subject: careerSubject(userId), issuedAt: now,
        expiresAt: now + CAREER_CURSOR_TTL_MS, country, profile, search, entries, offset: 0, coverage }, userId, country, now);
}
