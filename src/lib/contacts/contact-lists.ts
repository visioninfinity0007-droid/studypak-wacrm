// Contact lists (migration 066) — pure helpers for the import flow and
// the duplicates report. No I/O, so the rules are unit-testable.

export const LIST_NAME_MAX = 120;

/** "Rawalpindi Oct.xlsx" → "Rawalpindi Oct". */
export function defaultListName(fileName: string): string {
  const base = fileName.replace(/\.(csv|xlsx)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'Imported contacts').slice(0, LIST_NAME_MAX);
}

/** Same rule as the database's unique index: lower(btrim(name)). */
export function listNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export interface MatchedContact {
  contactId: string;
  phone: string;
  name: string | null;
}

export interface ListMembership {
  contactId: string;
  listId: string;
  listName: string;
}

export interface DuplicateRow {
  phone: string;
  name: string | null;
  /** Other lists this number is already in (not the one being imported into). */
  otherLists: string[];
  /** Already in the list being imported into (the same sheet uploaded twice). */
  inTargetList: boolean;
}

/**
 * Numbers in the uploaded sheet that were already contacts, with the
 * lists each one is already in — "this number also exists in list X".
 * Numbers in other lists come first, then by phone.
 */
export function buildDuplicateReport(
  matched: readonly MatchedContact[],
  memberships: readonly ListMembership[],
  targetListId: string | null,
): DuplicateRow[] {
  const listsByContact = new Map<string, ListMembership[]>();
  for (const m of memberships) {
    const arr = listsByContact.get(m.contactId) ?? [];
    arr.push(m);
    listsByContact.set(m.contactId, arr);
  }
  return matched
    .map((c) => {
      const lists = listsByContact.get(c.contactId) ?? [];
      return {
        phone: c.phone,
        name: c.name,
        otherLists: lists
          .filter((m) => m.listId !== targetListId)
          .map((m) => m.listName)
          .sort((a, b) => a.localeCompare(b)),
        inTargetList: lists.some((m) => m.listId === targetListId),
      };
    })
    .sort((a, b) =>
      Number(b.otherLists.length > 0) - Number(a.otherLists.length > 0) || a.phone.localeCompare(b.phone),
    );
}

export function csvCell(value: string): string {
  // Leading = + - @ would run as a formula in Excel.
  const safe = /^[=+\-@]/.test(value) && !/^\+\d/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The duplicates report as a CSV the college can open in Excel. */
export function duplicatesCsv(rows: readonly DuplicateRow[], header: [string, string, string]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([r.phone, r.name ?? '', r.otherLists.join('; ')].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
