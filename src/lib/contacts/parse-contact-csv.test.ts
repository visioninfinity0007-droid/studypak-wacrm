import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseContactSheet, parseTagCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: true,
      hasCompanyColumn: false,
      hasConsentColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
        },
      ],
    });
  });

  it('keeps a row with an empty phone cell instead of dropping it silently', () => {
    const csv = `phone,name
+15551234567,Alice
,Bob`;

    const { rows } = parseContactCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      phone: '',
      name: 'Bob',
      email: undefined,
      company: undefined,
      tagNames: [],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasPhoneColumn: true,
      hasTagsColumn: false,
      hasCompanyColumn: false,
      hasConsentColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
        },
      ],
    });
  });
});

describe('parseContactSheet (XLSX rows)', () => {
  it('reads the same columns as CSV and keeps long numeric phones intact', () => {
    const sheet = [
      ['Phone', 'Name', 'Tags', 'Consent'],
      [923105478805, 'Ali', 'fsc; 2026', 'yes'],
      ['03001234567', 'Sara', null, 'no'],
      [null, null, null, null],
      ['+92 333 1234567', 'Bilal', '', ''],
    ];
    const result = parseContactSheet(sheet);
    expect(result.hasPhoneColumn).toBe(true);
    expect(result.hasConsentColumn).toBe(true);
    expect(result.rows).toEqual([
      { phone: '923105478805', name: 'Ali', email: undefined, company: undefined, tagNames: ['fsc', '2026'], consent: true },
      { phone: '03001234567', name: 'Sara', email: undefined, company: undefined, tagNames: [], consent: false },
      { phone: '+92 333 1234567', name: 'Bilal', email: undefined, company: undefined, tagNames: [], consent: undefined },
    ]);
  });

  it('reports a missing phone column', () => {
    expect(parseContactSheet([['name'], ['Ali']]).hasPhoneColumn).toBe(false);
  });
});
