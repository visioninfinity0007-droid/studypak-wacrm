// College lifecycle status (migration 062). Browser-safe — no Node
// imports — so both the auth hook and server routes can share it.

export const COLLEGE_STATUSES = ['active', 'pending', 'suspended'] as const;
export type CollegeStatus = (typeof COLLEGE_STATUSES)[number];

export function isCollegeStatus(value: unknown): value is CollegeStatus {
  return typeof value === 'string' && (COLLEGE_STATUSES as readonly string[]).includes(value);
}

/** Accounts created before migration 062 have no status column value. */
export function normalizeCollegeStatus(value: unknown): CollegeStatus {
  return isCollegeStatus(value) ? value : 'active';
}
