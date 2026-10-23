// Pure helpers for the platform-admin oversight views: every college's
// broadcasts and recent activity on /admin. No I/O here so the rules are
// unit-testable; the routes in src/app/api/admin do the fetching.

import type { ActivityItem } from '@/lib/dashboard/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?college=` filter: a college id, or null for "all colleges". */
export function parseCollegeFilter(url: string): { ok: true; collegeId: string | null } | { ok: false } {
  const raw = new URL(url).searchParams.get('college');
  if (raw === null || raw === '' || raw === 'all') return { ok: true, collegeId: null };
  return UUID_RE.test(raw) ? { ok: true, collegeId: raw.toLowerCase() } : { ok: false };
}

export interface CollegeRef {
  id: string;
  name: string;
}

export interface AdminActivityItem extends Omit<ActivityItem, 'href'> {
  college: CollegeRef;
}

/**
 * Merge per-college activity into one newest-first feed, tagged with the
 * college. Links are dropped: they point at the member pages (Inbox,
 * Contacts…), which only ever show the admin's own college.
 */
export function mergeCollegeActivity(
  groups: { college: CollegeRef; items: ActivityItem[] }[],
  limit: number,
): AdminActivityItem[] {
  return groups
    .flatMap(({ college, items }) =>
      items.map((item) => ({
        id: `${college.id}:${item.id}`,
        kind: item.kind,
        text: item.text,
        at: item.at,
        college,
      })),
    )
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit);
}

export interface BroadcastRow {
  id: string;
  account_id: string;
  name: string;
  template_name: string | null;
  status: string;
  total_recipients: number | null;
  sent_count: number | null;
  delivered_count: number | null;
  read_count: number | null;
  replied_count: number | null;
  failed_count: number | null;
  created_at: string;
  scheduled_at: string | null;
}

export interface AdminBroadcast {
  id: string;
  college: CollegeRef;
  name: string;
  templateName: string | null;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  /** sent × the college's current PKR rate; null when no rate is set. */
  estimatedCostPkr: number | null;
}

export function toAdminBroadcast(
  row: BroadcastRow,
  colleges: Map<string, CollegeRef & { ratePkr: number | null }>,
): AdminBroadcast {
  const college = colleges.get(row.account_id);
  const sent = row.sent_count ?? 0;
  const rate = college?.ratePkr ?? null;
  return {
    id: row.id,
    college: { id: row.account_id, name: college?.name ?? '—' },
    name: row.name,
    templateName: row.template_name,
    status: row.status,
    createdAt: row.created_at,
    scheduledAt: row.scheduled_at,
    recipients: row.total_recipients ?? 0,
    sent,
    delivered: row.delivered_count ?? 0,
    read: row.read_count ?? 0,
    replied: row.replied_count ?? 0,
    failed: row.failed_count ?? 0,
    estimatedCostPkr: rate === null ? null : Math.round(sent * rate * 100) / 100,
  };
}

/** Failed recipients grouped by Meta's error text, most common first. */
export function summarizeFailures(
  rows: { error_message: string | null }[],
  limit = 10,
): { reason: string | null; count: number }[] {
  const counts = new Map<string | null, number>();
  for (const r of rows) {
    const reason = r.error_message?.trim() || null;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
