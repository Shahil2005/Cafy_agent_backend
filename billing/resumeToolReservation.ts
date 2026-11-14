import type { ResumeToolOperation } from './resumeToolOperations';

/** A failed ResumeTool call must refund within this window. */
export const RESUME_RESERVATION_TTL_MS = 30 * 60 * 1000;

const RESERVATION_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ResumeReservationError extends Error {
    readonly code = 'RESERVATION_INVALID';

    constructor() {
        super('RESERVATION_INVALID');
    }
}

export function isResumeReservationId(value: unknown): value is string {
    return typeof value === 'string' && RESERVATION_ID_RE.test(value);
}

export type ResumeReservationRecord = {
    uid?: unknown;
    operation?: unknown;
    expiresAtMs?: unknown;
};

/**
 * A refund is valid only for a reservation this server issued, for this user
 * and operation, and only before it expires. Missing, reused, or forged ids
 * are invalid.
 */
export function assessResumeReservation(
    reservation: ResumeReservationRecord | null | undefined,
    uid: string,
    operation: ResumeToolOperation,
    nowMs: number
): 'ok' | 'invalid' {
    if (!reservation) return 'invalid';
    if (reservation.uid !== uid) return 'invalid';
    if (reservation.operation !== operation) return 'invalid';
    if (typeof reservation.expiresAtMs !== 'number' || !Number.isFinite(reservation.expiresAtMs)) {
        return 'invalid';
    }
    if (reservation.expiresAtMs <= nowMs) return 'invalid';
    return 'ok';
}
