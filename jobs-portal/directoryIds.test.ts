import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isRegisterOnlyCompanyId,
    normalizeEmployerName,
    registerIdRange,
} from './directoryIds';

describe('normalizeEmployerName', () => {
    it('strips legal suffixes and punctuation', () => {
        assert.equal(normalizeEmployerName('NHS Trust Ltd.'), 'nhs trust');
        assert.equal(normalizeEmployerName("St Mary's Hospital PLC"), 'st marys hospital');
        assert.equal(normalizeEmployerName('  Google  Ireland  Limited  '), 'google ireland');
    });
});

describe('isRegisterOnlyCompanyId', () => {
    it('detects reserved UK and Ireland ranges', () => {
        assert.equal(isRegisterOnlyCompanyId(1690), false);
        assert.equal(isRegisterOnlyCompanyId(7_000_000), true);
        assert.equal(isRegisterOnlyCompanyId(8_000_001), true);
        assert.equal(isRegisterOnlyCompanyId(900_003), false);
        assert.equal(registerIdRange('uk').min, 7_000_000);
        assert.equal(registerIdRange('ireland').min, 8_000_000);
    });
});
