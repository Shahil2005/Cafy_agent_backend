import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    assessResumeReservation,
    isResumeReservationId,
} from './resumeToolReservation';

const NOW = 1_700_000_000_000;

describe('assessResumeReservation', () => {
    const live = {
        uid: 'user-1',
        operation: 'analyse' as const,
        expiresAtMs: NOW + 60_000,
    };

    it('accepts a live reservation for the same user and operation', () => {
        assert.equal(assessResumeReservation(live, 'user-1', 'analyse', NOW), 'ok');
    });

    it('rejects a refund when no reservation was issued', () => {
        assert.equal(assessResumeReservation(null, 'user-1', 'analyse', NOW), 'invalid');
        assert.equal(assessResumeReservation(undefined, 'user-1', 'analyse', NOW), 'invalid');
    });

    it('rejects a reservation that belongs to someone else', () => {
        assert.equal(assessResumeReservation(live, 'user-2', 'analyse', NOW), 'invalid');
    });

    it('rejects a reservation for a different operation', () => {
        assert.equal(assessResumeReservation(live, 'user-1', 'import', NOW), 'invalid');
    });

    it('rejects an expired reservation', () => {
        assert.equal(
            assessResumeReservation({ ...live, expiresAtMs: NOW }, 'user-1', 'analyse', NOW),
            'invalid'
        );
        assert.equal(
            assessResumeReservation({ ...live, expiresAtMs: NOW - 1 }, 'user-1', 'analyse', NOW),
            'invalid'
        );
    });

    it('rejects a reservation with no expiry', () => {
        assert.equal(
            assessResumeReservation({ uid: 'user-1', operation: 'analyse' }, 'user-1', 'analyse', NOW),
            'invalid'
        );
    });
});

describe('isResumeReservationId', () => {
    it('accepts only a uuid', () => {
        assert.equal(isResumeReservationId('3b1f8c2a-7d4e-4a1b-9c3d-6e5f7a8b9c0d'), true);
        assert.equal(isResumeReservationId(''), false);
        assert.equal(isResumeReservationId('not-a-uuid'), false);
        assert.equal(isResumeReservationId('../usage'), false);
        assert.equal(isResumeReservationId(undefined), false);
    });
});
