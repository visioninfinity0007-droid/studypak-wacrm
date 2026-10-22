/**
 * CSV / XLSX parsing for the contacts import modal. Shared + unit-tested
 * so tag-column handling stays aligned with phone/name/email/company.
 * Both formats go through parseContactRecords(), so an Excel sheet and a
 * CSV with the same columns produce identical rows.
 */

import { parseConsentCell } from './consent';

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
  /** Optional per-row `consent` column: true/false, undefined when blank. */
  consent?: boolean;
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /**
   * True when the CSV header includes the required `phone` column.
   * `rows` is empty both when the column is missing and when the file
   * simply has no usable data rows; callers that need to tell those
   * apart (to pick the right error message) read this flag.
   */
  hasPhoneColumn: boolean;
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
  /** True when the header includes a `consent` column. */
  hasConsentColumn?: boolean;
}

const EMPTY_RESULT: ParseContactCsvResult = {
  rows: [],
  hasPhoneColumn: false,
  hasTagsColumn: false,
  hasCompanyColumn: false,
  hasConsentColumn: false,
};

/**
 * Turn a header row + data rows (already split into cells) into contact
 * rows. Header matching is case-insensitive; quotes are stripped.
 */
export function parseContactRecords(
  headerCells: readonly unknown[],
  records: readonly (readonly unknown[])[],
): ParseContactCsvResult {
  const headers = headerCells.map((h) => cellText(h).toLowerCase());
  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx === -1) return { ...EMPTY_RESULT };

  const nameIdx = headers.indexOf('name');
  const emailIdx = headers.indexOf('email');
  const companyIdx = headers.indexOf('company');
  const tagsIdx = headers.indexOf('tags');
  const consentIdx = headers.indexOf('consent');

  const optional = (values: readonly unknown[], idx: number) =>
    idx >= 0 ? cellText(values[idx]) || undefined : undefined;

  const rows: ParsedContactRow[] = [];
  for (const values of records) {
    if (values.every((v) => cellText(v) === '')) continue;
    // A row with no usable phone is pushed through rather than dropped
    // here — dedupeByPhone (shared with the webhook/manual-form paths)
    // already treats an empty normalized key as invalid, and counting
    // it there means the import result can tell the user "N contacts
    // had no phone" instead of the row just vanishing with the total
    // row count silently short of what's actually in the file.
    const row: ParsedContactRow = {
      phone: cellText(values[phoneIdx]),
      name: optional(values, nameIdx),
      email: optional(values, emailIdx),
      company: optional(values, companyIdx),
      tagNames: tagsIdx >= 0 ? parseTagCell(cellText(values[tagsIdx])) : [],
    };
    if (consentIdx >= 0) row.consent = parseConsentCell(values[consentIdx] ?? undefined);
    rows.push(row);
  }

  return {
    rows,
    hasPhoneColumn: true,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
    hasConsentColumn: consentIdx >= 0,
  };
}

/**
 * Spreadsheet rows (first row = header) as returned by read-excel-file.
 * Excel stores long phone numbers as numbers — they're converted back to
 * digit strings without exponent notation.
 */
export function parseContactSheet(sheet: readonly (readonly unknown[])[]): ParseContactCsvResult {
  if (sheet.length < 2) return { ...EMPTY_RESULT };
  return parseContactRecords(sheet[0], sheet.slice(1));
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(Math.round(value)).toString() : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return '';
  return String(value).replace(/["']/g, '').trim();
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { ...EMPTY_RESULT };
  const records = lines
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => parseCsvLine(line.trim()));
  return parseContactRecords(lines[0].split(','), records);
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
