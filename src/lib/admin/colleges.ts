// Pure helpers for the platform-admin college routes (contract
// requirement 1). No I/O here so the rules are unit-testable.

import { randomInt } from 'node:crypto';
import { parseBroadcastRate } from '@/lib/broadcast-cost';

import { isCollegeStatus, type CollegeStatus } from './college-status';

export { COLLEGE_STATUSES, isCollegeStatus, normalizeCollegeStatus } from './college-status';
export type { CollegeStatus } from './college-status';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface NewCollegeInput {
  collegeName: string;
  adminName: string;
  adminEmail: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; field: string };

export function validateNewCollege(body: unknown): ValidationResult<NewCollegeInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const collegeName = typeof b.collegeName === 'string' ? b.collegeName.trim() : '';
  const adminName = typeof b.adminName === 'string' ? b.adminName.trim() : '';
  const adminEmail = typeof b.adminEmail === 'string' ? b.adminEmail.trim().toLowerCase() : '';
  if (collegeName.length < 2 || collegeName.length > 120) return { ok: false, field: 'collegeName' };
  if (adminName.length < 2 || adminName.length > 120) return { ok: false, field: 'adminName' };
  if (!EMAIL_RE.test(adminEmail) || adminEmail.length > 254) return { ok: false, field: 'adminEmail' };
  return { ok: true, value: { collegeName, adminName, adminEmail } };
}

export interface CollegeUpdate {
  name?: string;
  status?: CollegeStatus;
  broadcast_rate_pkr?: number | null;
}

/**
 * Validate a PATCH body. `broadcastRatePkr` accepts a number/string
 * rate, or null / '' to clear it ("not configured" — sending then stays
 * blocked by the cost-preview guard).
 */
export function validateCollegeUpdate(body: unknown): ValidationResult<CollegeUpdate> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: CollegeUpdate = {};
  if ('name' in b) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 2 || name.length > 120) return { ok: false, field: 'name' };
    out.name = name;
  }
  if ('status' in b) {
    if (!isCollegeStatus(b.status)) return { ok: false, field: 'status' };
    out.status = b.status;
  }
  if ('broadcastRatePkr' in b) {
    const raw = b.broadcastRatePkr;
    if (raw === null || raw === '') {
      out.broadcast_rate_pkr = null;
    } else {
      const parsed = parseBroadcastRate(String(raw));
      if (parsed === null) return { ok: false, field: 'broadcastRatePkr' };
      out.broadcast_rate_pkr = parsed;
    }
  }
  if (Object.keys(out).length === 0) return { ok: false, field: 'body' };
  return { ok: true, value: out };
}

// No look-alike characters (0/O, 1/l/I) — the password is read out or
// pasted into WhatsApp by a human.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** One-time password the college admin changes after first sign-in. */
export function generateTempPassword(length = 14): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}
