import { describe, expect, it } from 'vitest';

import {
  buildDuplicateReport,
  defaultListName,
  duplicatesCsv,
  listNameKey,
} from './contact-lists';
import { splitAlreadySent } from '@/lib/broadcast-audience';

describe('defaultListName', () => {
  it('uses the file name without its extension', () => {
    expect(defaultListName('Rawalpindi Oct.xlsx')).toBe('Rawalpindi Oct');
    expect(defaultListName('lahore_nov_2026.CSV')).toBe('lahore nov 2026');
  });

  it('falls back when the name is empty and caps the length', () => {
    expect(defaultListName('.csv')).toBe('Imported contacts');
    expect(defaultListName(`${'a'.repeat(200)}.csv`)).toHaveLength(120);
  });
});

describe('listNameKey', () => {
  it('matches the database rule lower(btrim(name))', () => {
    expect(listNameKey('  Rawalpindi Oct ')).toBe('rawalpindi oct');
  });
});

describe('buildDuplicateReport', () => {
  const matched = [
    { contactId: 'c1', phone: '+923001110001', name: 'Ali' },
    { contactId: 'c2', phone: '+923001110002', name: null },
    { contactId: 'c3', phone: '+923001110000', name: 'Sara' },
  ];
  const memberships = [
    { contactId: 'c2', listId: 'L-rwp', listName: 'Rawalpindi Oct' },
    { contactId: 'c2', listId: 'L-lhr', listName: 'Lahore Nov' },
    { contactId: 'c3', listId: 'L-target', listName: 'This upload' },
  ];

  it('lists the other lists each number is in, numbers in other lists first', () => {
    expect(buildDuplicateReport(matched, memberships, 'L-target')).toEqual([
      { phone: '+923001110002', name: null, otherLists: ['Lahore Nov', 'Rawalpindi Oct'], inTargetList: false },
      { phone: '+923001110000', name: 'Sara', otherLists: [], inTargetList: true },
      { phone: '+923001110001', name: 'Ali', otherLists: [], inTargetList: false },
    ]);
  });

  it('counts every list as "other" when importing without a list', () => {
    const [first] = buildDuplicateReport(matched, memberships, null);
    expect(first.otherLists).toEqual(['Lahore Nov', 'Rawalpindi Oct']);
  });
});

describe('duplicatesCsv', () => {
  it('writes a header and escapes commas, quotes and formulas', () => {
    const csv = duplicatesCsv(
      [
        { phone: '+923001110002', name: 'Khan, "Ali"', otherLists: ['A', 'B'], inTargetList: false },
        { phone: '+923001110003', name: '=HYPERLINK("x")', otherLists: [], inTargetList: false },
      ],
      ['Phone', 'Name', 'Also in lists'],
    );
    expect(csv).toBe(
      'Phone,Name,Also in lists\r\n' +
        '+923001110002,"Khan, ""Ali""",A; B\r\n' +
        `+923001110003,"'=HYPERLINK(""x"")",\r\n`,
    );
  });
});

describe('splitAlreadySent', () => {
  it('separates contacts that already received the template', () => {
    const contacts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(splitAlreadySent(contacts, new Set(['b']))).toEqual({
      toSend: [{ id: 'a' }, { id: 'c' }],
      alreadySent: [{ id: 'b' }],
    });
  });
});
