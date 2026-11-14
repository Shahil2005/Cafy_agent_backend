import { createHash } from 'node:crypto';
import * as admin from 'firebase-admin';
import { careerText } from '../../jobs-portal/careerMatchProfile';
import type { AgentAiCall } from '../usage';
import { chunkCv } from './chunk';
import { cosine, embedTexts, type EmbedFn } from './embed';
import { extractCvProfile, type CvProfile } from './profile';
import { experienceYears, type ExperienceSummary } from './years';

export const MAX_CV_CHARS = 120_000;
/**
 * 3: smaller pieces (1,500 characters) so none exceeds the embedding model's 512-token window. 4: divider lines shortened.
 * 5: pieces counted in real model tokens and cut smaller where needed (dense skill lists reached 760 tokens).
 */
export const CV_INDEX_VERSION = 5;
/** Saved analyses from this version on keep their profile; only their pieces and vectors are redone. */
const REPIECE_FROM_VERSION = 4;
const MAX_STORED_CV_BYTES = 900_000;
const CV_RETENTION_DAYS = 90;

/** Stored at users/{uid}/agentCvProfiles/{hash}: a NEW path, written only by the agent. */
export interface CvIndex {
    version: number;
    name: string;
    /** Saved resume ids this analysis came from ('profile' for the profile CV); used to clean up on delete. */
    sourceCvIds?: string[];
    hash: string;
    createdAt: number;
    expiresAt: number;
    /** CV text after contact details were removed; the source for quotes. */
    text: string;
    profile: CvProfile;
    chunks: Array<{ index: number; section: string; text: string; embedding: number[] }>;
}

export interface CvStore {
    get(uid: string, hash: string): Promise<CvIndex | null>;
    put(uid: string, index: CvIndex): Promise<void>;
}

function collection(uid: string) {
    return admin.firestore().collection('users').doc(uid).collection('agentCvProfiles');
}

/** Vectors are stored as one base64 float32 string each: half the size, and nothing for Firestore to index. */
export function packVector(vector: number[]): string {
    return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

export function unpackVector(packed: string): number[] {
    const bytes = Buffer.from(packed, 'base64');
    return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)));
}

type StoredCvIndex = Omit<CvIndex, 'chunks' | 'text'> & { text?: string } & { chunks: Array<Omit<CvIndex['chunks'][number], 'embedding'> & { vector: string }> };

export const firestoreCvStore: CvStore = {
    async get(uid, hash) {
        const snap = await collection(uid).doc(hash).get();
        if (!snap.exists) return null;
        const data = snap.data() as StoredCvIndex;
        // Version 4 has the same profile; only its pieces are redone (free) when it is next used.
        if (data.version < REPIECE_FROM_VERSION || data.version > CV_INDEX_VERSION || data.expiresAt < Date.now()) return null;
        const chunks = data.chunks.map(({ vector, ...chunk }) => ({ ...chunk, embedding: vector ? unpackVector(vector) : [] }));
        // A very large CV is stored without its duplicate full text; the pieces cover every word.
        return { ...data, text: data.text ?? chunks.map((c) => c.text).join('\n'), chunks };
    },
    async put(uid, index) {
        const stored: StoredCvIndex = {
            ...index,
            chunks: index.chunks.map(({ embedding, ...chunk }) => ({ ...chunk, vector: embedding.length ? packVector(embedding) : '' })),
        };
        // JSON round-trip drops undefined values, which Firestore rejects.
        let doc = JSON.parse(JSON.stringify(stored)) as Partial<StoredCvIndex>;
        // Firestore's document limit is 1 MiB: drop the duplicate text (rebuilt from the pieces on load).
        if (JSON.stringify(doc).length > MAX_STORED_CV_BYTES) {
            const { text: _omitted, ...rest } = doc;
            doc = rest;
        }
        await collection(uid).doc(index.hash).set(doc);
    },
};

export function cvHash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 40);
}

export type CvStage = 'load' | 'understand' | 'index' | 'save';

/** Carries which step failed. Its message never contains CV text. */
export class CvIndexError extends Error {
    constructor(readonly stage: CvStage, readonly cause: unknown) {
        super(`CV indexing failed at ${stage}`);
        this.name = 'CvIndexError';
    }
}

/** Safe diagnostic summary: error class, code and a short message (Firestore paths, HTTP status), never CV text. */
export function describeCvError(error: unknown): Record<string, unknown> {
    const stage = error instanceof CvIndexError ? error.stage : 'unknown';
    const cause = error instanceof CvIndexError ? error.cause : error;
    const e = cause as { name?: string; code?: unknown; status?: unknown; reason?: unknown } | undefined;
    // Never the error message: provider and service messages can echo CV text back.
    return {
        stage,
        error: e?.name,
        code: typeof e?.code === 'string' || typeof e?.code === 'number' ? e.code : undefined,
        status: typeof e?.status === 'number' ? e.status : undefined,
        reason: typeof e?.reason === 'string' ? e.reason : undefined,
    };
}

async function atStage<T>(stage: CvStage, task: Promise<T>): Promise<T> {
    try {
        return await task;
    } catch (error) {
        throw new CvIndexError(stage, error);
    }
}

export type CvProgress = (step: 'read' | 'understand' | 'index', state: 'running' | 'done', detail?: string) => void;

/**
 * Reads a CV once per version: removes contact details, extracts the evidenced profile (one AI call)
 * and embeds every piece (free, Supabase gte-small), in parallel. Later turns reuse the stored result.
 */
export async function indexCv(
    uid: string,
    cv: { name: string; text: string; sourceId?: string },
    options: {
        signal: AbortSignal;
        progress?: CvProgress;
        store?: CvStore;
        embed?: EmbedFn;
        extract?: typeof extractCvProfile;
    },
): Promise<{ index: CvIndex; cached: boolean; calls: AgentAiCall[] }> {
    const store = options.store ?? firestoreCvStore;
    const progress = options.progress ?? (() => undefined);
    const text = careerText(cv.text.slice(0, MAX_CV_CHARS));
    const hash = cvHash(text);
    const existing = await atStage('load', store.get(uid, hash));
    if (existing) {
        // Older saved analyses get the code-checked skill labels too, without re-reading the CV.
        const sources = new Set(existing.sourceCvIds ?? []);
        if (cv.sourceId && !sources.has(cv.sourceId)) {
            sources.add(cv.sourceId);
            // Records the new source on the agent's own doc; a failure only delays clean-up.
            await store.put(uid, { ...existing, sourceCvIds: [...sources] }).catch(() => undefined);
        }
        let chunks = existing.chunks;
        if (existing.version !== CV_INDEX_VERSION) {
            // Saved before pieces were cut to the model's token window: cut and embed them again (free, no AI call).
            // The text is the same (same hash), so the profile and its quotes stay valid.
            const pieces = chunkCv(text);
            const vectors = await (options.embed ?? embedTexts)(pieces.map((p) => `${p.section}: ${p.text}`)).catch(() => [] as number[][]);
            chunks = pieces.map((p, i) => ({ ...p, embedding: vectors[i] ?? [] }));
            await store.put(uid, { ...existing, version: CV_INDEX_VERSION, sourceCvIds: [...sources], chunks }).catch(() => undefined);
            return {
                index: { ...existing, version: CV_INDEX_VERSION, chunks, name: cv.name, sourceCvIds: [...sources], profile: upgradeSkillSources(existing.profile, chunks) },
                cached: true,
                calls: [],
            };
        }
        if (chunks.some((c) => !c.embedding.length)) {
            // Saved while the embedding service was down: fill the vectors in now (free), best-effort.
            const vectors = await (options.embed ?? embedTexts)(chunks.map((p) => `${p.section}: ${p.text}`)).catch(() => null);
            if (vectors) {
                chunks = chunks.map((c, i) => ({ ...c, embedding: vectors[i] ?? [] }));
                await store.put(uid, { ...existing, sourceCvIds: [...sources], chunks }).catch(() => undefined);
            }
        }
        return {
            index: { ...existing, chunks, name: cv.name, sourceCvIds: [...sources], profile: upgradeSkillSources(existing.profile, existing.chunks) },
            cached: true,
            calls: [],
        };
    }

    progress('read', 'running');
    const pieces = chunkCv(text);
    progress('read', 'done', `${pieces.length} sections and pieces`);
    progress('understand', 'running');
    progress('index', 'running');
    const [extracted, vectors] = await Promise.all([
        atStage('understand', (options.extract ?? extractCvProfile)(text, { signal: options.signal })).then((r) => {
            progress('understand', 'done');
            return r;
        }),
        (options.embed ?? embedTexts)(pieces.map((p) => `${p.section}: ${p.text}`)).then(
            (v) => {
                progress('index', 'done', `${pieces.length} pieces`);
                return v as Array<number[] | undefined>;
            },
            (error) => {
                // Search falls back to word matching; vectors are filled in next time this CV is chosen.
                console.warn('[agent] CV embedding unavailable', describeCvError(new CvIndexError('index', error)));
                progress('index', 'done', 'word search for now');
                return [] as Array<number[] | undefined>;
            },
        ),
    ]);
    const now = Date.now();
    const index: CvIndex = {
        version: CV_INDEX_VERSION,
        name: cv.name.slice(0, 120),
        ...(cv.sourceId ? { sourceCvIds: [cv.sourceId] } : {}),
        hash,
        createdAt: now,
        expiresAt: now + CV_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        text,
        profile: upgradeSkillSources(extracted.profile, pieces),
        chunks: pieces.map((p, i) => ({ ...p, embedding: vectors[i] ?? [] })),
    };
    try {
        await store.put(uid, index);
    } catch (error) {
        // The CV is still used for this answer; only the reuse on later turns is lost.
        console.warn('[agent] CV analysis could not be saved', describeCvError(new CvIndexError('save', error)));
    }
    return { index, cached: false, calls: extracted.calls };
}

const WORK_SECTION = /experience|employment|work|career|internship|placement|professional history/i;
const PROJECT_SECTION = /project|portfolio/i;
const SOURCE_RANK: Record<string, number> = { experience: 4, project: 3, education: 2, 'skills-list': 1, other: 0 };

function mentions(text: string, skill: string): boolean {
    const escaped = skill.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text.toLowerCase());
}

/**
 * The cheap model often labels every skill "listed". Code checks where each skill really
 * appears: inside a work/internship section means "experience", inside projects means "project".
 * A label is only ever upgraded, never downgraded.
 */
export function upgradeSkillSources(profile: CvProfile, pieces: Array<{ section: string; text: string }>): CvProfile {
    const work = pieces.filter((p) => WORK_SECTION.test(p.section)).map((p) => p.text);
    const projects = pieces.filter((p) => PROJECT_SECTION.test(p.section)).map((p) => p.text);
    const roleText = profile.roles.map((r) => r.evidence);
    const projectText = profile.projects.map((p) => `${p.name} ${p.technologies.join(' ')} ${p.evidence}`);
    return {
        ...profile,
        skills: profile.skills.map((skill) => {
            const found = [...work, ...roleText].some((t) => mentions(t, skill.name))
                ? 'experience'
                : [...projects, ...projectText].some((t) => mentions(t, skill.name))
                  ? 'project'
                  : skill.source;
            return SOURCE_RANK[found]! > SOURCE_RANK[skill.source]! ? { ...skill, source: found } : skill;
        }),
    };
}

export interface CvExperience extends ExperienceSummary {
    volunteeringYears: number;
    note: string;
}

/** Paid jobs and internships count as professional experience; volunteering is reported separately. */
export function cvExperience(index: CvIndex, now = new Date()): CvExperience {
    const roles = index.profile.roles;
    const professional = experienceYears(roles.filter((r) => r.type !== 'volunteering'), now);
    const volunteering = experienceYears(roles.filter((r) => r.type === 'volunteering'), now);
    return {
        ...professional,
        volunteeringYears: volunteering.years,
        note: 'years = paid jobs and internships with overlaps merged; volunteering is separate; projects and education are excluded.',
    };
}

/** Top pieces of the whole CV for a question, by meaning (one free embedding call for the query). */
export async function searchCv(
    index: CvIndex,
    query: string,
    options: { embed?: EmbedFn; limit?: number } = {},
): Promise<Array<{ section: string; text: string; score: number }>> {
    const hasVectors = index.chunks.some((c) => c.embedding.length);
    const vector = hasVectors ? (await (options.embed ?? embedTexts)([query.slice(0, 1000)]).catch(() => []))[0] : undefined;
    // Without vectors (embedding service down), rank pieces by shared words: still covers the whole CV.
    const score = vector
        ? (chunk: CvIndex['chunks'][number]) => (chunk.embedding.length ? cosine(vector, chunk.embedding) : 0)
        : wordOverlapScorer(query);
    return index.chunks
        .map((chunk) => ({ section: chunk.section, text: chunk.text, score: score(chunk) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit ?? 4)
        .map((hit) => ({ ...hit, score: Math.round(hit.score * 1000) / 1000 }));
}

function wordSet(value: string): Set<string> {
    return new Set(value.toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).filter((w) => w.length > 1));
}

/** Fraction of the query's words found in a piece. */
export function wordOverlapScorer(query: string): (chunk: { text: string; section: string }) => number {
    const q = [...wordSet(query)];
    return (chunk) => {
        if (!q.length) return 0;
        const words = wordSet(`${chunk.section} ${chunk.text}`);
        return q.filter((w) => words.has(w)).length / q.length;
    };
}

/** Short context line sent with every turn so the agent knows which CV is in use. */
export function cvContextSummary(index: CvIndex): Record<string, unknown> {
    const experience = cvExperience(index);
    return {
        name: index.name,
        headline: index.profile.headline,
        professionalYears: experience.years,
        volunteeringYears: experience.volunteeringYears,
        roles: index.profile.roles.slice(0, 6).map((r) => [r.title, r.employer].filter(Boolean).join(' at ')),
        topSkills: index.profile.skills.slice(0, 12).map((s) => s.name),
        education: index.profile.education.slice(0, 3).map((e) => [e.qualification, e.institution, e.grade].filter(Boolean).join(', ')),
        certifications: index.profile.certifications.slice(0, 6).map((c) => c.name),
        projectCount: index.profile.projects.length,
        note: 'Short summary only. Use the CV tools for anything else.',
    };
}
