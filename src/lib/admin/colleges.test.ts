import { describe, expect, it } from 'vitest';

import {
  generateTempPassword,
  normalizeCollegeStatus,
  validateCollegeUpdate,
  validateNewCollege,
} from './colleges';

describe('validateNewCollege', () => {
  it('trims fields and lowercases the email', () => {
    expect(
      validateNewCollege({ collegeName: '  Watim College ', adminName: ' Ali ', adminEmail: ' Ali@Example.COM ' }),
    ).toEqual({ ok: true, value: { collegeName: 'Watim College', adminName: 'Ali', adminEmail: 'ali@example.com' } });
  });

  it.each([
    [{ collegeName: 'A', adminName: 'Ali', adminEmail: 'a@b.co' }, 'collegeName'],
    [{ collegeName: 'Watim', adminName: '', adminEmail: 'a@b.co' }, 'adminName'],
    [{ collegeName: 'Watim', adminName: 'Ali', adminEmail: 'not-an-email' }, 'adminEmail'],
    [null, 'collegeName'],
  ])('rejects %j on %s', (body, field) => {
    expect(validateNewCollege(body)).toEqual({ ok: false, field });
  });
});

describe('validateCollegeUpdate', () => {
  it('accepts a status change', () => {
    expect(validateCollegeUpdate({ status: 'suspended' })).toEqual({ ok: true, value: { status: 'suspended' } });
  });

  it('rejects an unknown status', () => {
    expect(validateCollegeUpdate({ status: 'deleted' })).toEqual({ ok: false, field: 'status' });
  });

  it('parses a PKR rate and clears it with null or empty string', () => {
    expect(validateCollegeUpdate({ broadcastRatePkr: '12.5' })).toEqual({ ok: true, value: { broadcast_rate_pkr: 12.5 } });
    expect(validateCollegeUpdate({ broadcastRatePkr: '' })).toEqual({ ok: true, value: { broadcast_rate_pkr: null } });
    expect(validateCollegeUpdate({ broadcastRatePkr: null })).toEqual({ ok: true, value: { broadcast_rate_pkr: null } });
  });

  it('rejects an invalid rate', () => {
    expect(validateCollegeUpdate({ broadcastRatePkr: '-1' })).toEqual({ ok: false, field: 'broadcastRatePkr' });
    expect(validateCollegeUpdate({ broadcastRatePkr: '100000' })).toEqual({ ok: false, field: 'broadcastRatePkr' });
  });

  it('rejects an empty body', () => {
    expect(validateCollegeUpdate({})).toEqual({ ok: false, field: 'body' });
  });
});

describe('normalizeCollegeStatus', () => {
  it('treats missing or unknown status as active (pre-062 accounts)', () => {
    expect(normalizeCollegeStatus(undefined)).toBe('active');
    expect(normalizeCollegeStatus('weird')).toBe('active');
    expect(normalizeCollegeStatus('pending')).toBe('pending');
  });
});

describe('generateTempPassword', () => {
  it('is 14 characters from an unambiguous alphabet', () => {
    const pw = generateTempPassword();
    expect(pw).toHaveLength(14);
    expect(pw).not.toMatch(/[0O1lI]/);
  });

  it('differs between calls', () => {
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});
