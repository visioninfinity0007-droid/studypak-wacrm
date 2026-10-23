'use client';

// Platform-admin oversight: every college's campaigns and recent
// activity, alongside college management on /admin. Read-only; data
// comes from /api/admin/broadcasts and /api/admin/activity, which use
// the service-role client behind requirePlatformAdmin().

import { useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { toast } from 'sonner';
import { Activity, Briefcase, Loader2, MessageSquare, Radio, RefreshCw, UserPlus, Zap } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AdminActivityItem, AdminBroadcast, CollegeRef } from '@/lib/admin/oversight';
import type { ActivityKind } from '@/lib/dashboard/types';

const BROADCAST_STATUSES = new Set(['draft', 'scheduled', 'sending', 'sent', 'failed']);

const KIND_ICON: Record<ActivityKind, ComponentType<{ className?: string }>> = {
  message: MessageSquare,
  contact: UserPlus,
  deal: Briefcase,
  broadcast: Radio,
  automation: Zap,
};

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === 'string' && body.error) || fallback;
}

/** Fetch `/api/admin/<path>?college=` and re-fetch when the filter changes. */
function useAdminList<T>(path: string, key: string, collegeId: string) {
  const t = useTranslations('Admin');
  // Tagged with the filter it was loaded for, so switching college shows
  // the spinner instead of the previous college's rows.
  const [result, setResult] = useState<{ collegeId: string; items: T[] } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = collegeId ? `?college=${encodeURIComponent(collegeId)}` : '';
      const res = await fetch(`/api/admin/${path}${qs}`, { cache: 'no-store' });
      if (!res.ok) {
        toast.error(await readError(res, t('listLoadFailed')));
        return;
      }
      const body = (await res.json()) as Record<string, T[]>;
      setResult({ collegeId, items: body[key] ?? [] });
    } catch {
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [path, key, collegeId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const data = result?.collegeId === collegeId ? result.items : null;
  return { data, loading, load };
}

function Toolbar({
  title,
  description,
  colleges,
  collegeId,
  onCollegeChange,
  loading,
  onRefresh,
}: {
  title: string;
  description: string;
  colleges: CollegeRef[];
  collegeId: string;
  onCollegeChange: (id: string) => void;
  loading: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations('Admin');
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <select
          aria-label={t('filterCollege')}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={collegeId}
          onChange={(e) => onCollegeChange(e.target.value)}
        >
          <option value="">{t('allColleges')}</option>
          {colleges.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <Button variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          {t('refresh')}
        </Button>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center p-10 text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

export function BroadcastsOverview({
  colleges,
  collegeId,
  onCollegeChange,
}: {
  colleges: CollegeRef[];
  collegeId: string;
  onCollegeChange: (id: string) => void;
}) {
  const t = useTranslations('Admin');
  const tb = useTranslations('Broadcasts');
  const format = useFormatter();
  const { data, loading, load } = useAdminList<AdminBroadcast>('broadcasts', 'broadcasts', collegeId);
  const [failuresFor, setFailuresFor] = useState<AdminBroadcast | null>(null);

  const num = (n: number) => format.number(n);

  return (
    <div className="space-y-4">
      <Toolbar
        title={t('broadcastsTitle')}
        description={t('broadcastsDescription')}
        colleges={colleges}
        collegeId={collegeId}
        onCollegeChange={onCollegeChange}
        loading={loading}
        onRefresh={() => void load()}
      />
      <Card className="border-border bg-card">
        <CardContent className="p-0">
          {data === null ? (
            <Loading />
          ) : data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{t('broadcastsEmpty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('colCampaign')}</TableHead>
                    <TableHead>{t('colCollege')}</TableHead>
                    <TableHead>{t('colStatus')}</TableHead>
                    <TableHead className="text-right">{t('colRecipients')}</TableHead>
                    <TableHead className="text-right">{t('colSent')}</TableHead>
                    <TableHead className="text-right">{t('colDelivered')}</TableHead>
                    <TableHead className="text-right">{t('colRead')}</TableHead>
                    <TableHead className="text-right">{t('colReplied')}</TableHead>
                    <TableHead className="text-right">{t('colFailed')}</TableHead>
                    <TableHead className="text-right">{t('colCost')}</TableHead>
                    <TableHead>{t('colCreated')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell>
                        <div className="font-medium text-foreground">{b.name}</div>
                        <div className="text-xs text-muted-foreground">{b.templateName ?? '—'}</div>
                      </TableCell>
                      <TableCell className="text-sm">{b.college.name}</TableCell>
                      <TableCell>
                        <Badge variant={b.status === 'failed' ? 'destructive' : b.status === 'sent' ? 'default' : 'secondary'}>
                          {tb(`status.${BROADCAST_STATUSES.has(b.status) ? b.status : 'unknown'}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(b.recipients)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(b.sent)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(b.delivered)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(b.read)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(b.replied)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {b.failed > 0 ? (
                          <button
                            type="button"
                            className="text-destructive underline-offset-2 hover:underline"
                            title={t('viewFailures')}
                            onClick={() => setFailuresFor(b)}
                          >
                            {num(b.failed)}
                          </button>
                        ) : (
                          num(0)
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {b.estimatedCostPkr === null ? '—' : t('pkr', { amount: num(b.estimatedCostPkr) })}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {format.dateTime(new Date(b.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">{t('costHint')}</p>
      <FailuresDialog broadcast={failuresFor} onClose={() => setFailuresFor(null)} />
    </div>
  );
}

function FailuresDialog({ broadcast, onClose }: { broadcast: AdminBroadcast | null; onClose: () => void }) {
  const t = useTranslations('Admin');
  const [loaded, setLoaded] = useState<{ id: string; failures: { reason: string | null; count: number }[] } | null>(null);
  const failures = broadcast && loaded?.id === broadcast.id ? loaded.failures : null;

  useEffect(() => {
    if (!broadcast) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/admin/broadcasts/${broadcast.id}`, { cache: 'no-store' });
        if (!res.ok) {
          toast.error(await readError(res, t('listLoadFailed')));
          return;
        }
        const body = (await res.json()) as { failures: { reason: string | null; count: number }[] };
        if (!cancelled) setLoaded({ id: broadcast.id, failures: body.failures });
      } catch {
        toast.error(t('networkError'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [broadcast, t]);

  return (
    <Dialog open={!!broadcast} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-popover border-border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('failuresTitle')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {broadcast ? t('failuresDesc', { campaign: broadcast.name, college: broadcast.college.name }) : ''}
          </DialogDescription>
        </DialogHeader>
        {failures === null ? (
          <Loading />
        ) : failures.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('failuresNone')}</p>
        ) : (
          <ul className="space-y-2">
            {failures.map((f) => (
              <li key={f.reason ?? '—'} className="flex items-start justify-between gap-4 text-sm">
                <span className="text-foreground">{f.reason ?? t('failureNoReason')}</span>
                <span className="tabular-nums text-muted-foreground">{f.count}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter className="bg-popover border-border">
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ActivityOverview({
  colleges,
  collegeId,
  onCollegeChange,
}: {
  colleges: CollegeRef[];
  collegeId: string;
  onCollegeChange: (id: string) => void;
}) {
  const t = useTranslations('Admin');
  const format = useFormatter();
  const { data, loading, load } = useAdminList<AdminActivityItem>('activity', 'items', collegeId);

  return (
    <div className="space-y-4">
      <Toolbar
        title={t('activityTitle')}
        description={t('activityDescription')}
        colleges={colleges}
        collegeId={collegeId}
        onCollegeChange={onCollegeChange}
        loading={loading}
        onRefresh={() => void load()}
      />
      <Card className="border-border bg-card">
        <CardContent className="p-0">
          {data === null ? (
            <Loading />
          ) : data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{t('activityEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.map((item) => {
                const Icon = KIND_ICON[item.kind] ?? Activity;
                return (
                  <li key={item.id} className="flex items-start gap-3 px-5 py-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground">{item.text}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.college.name} · {format.relativeTime(new Date(item.at), new Date())}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
