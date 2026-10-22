'use client';

// Platform-admin college management (contract requirement 1).
// Lists every college with usage, creates colleges (one-time login for
// the college admin), approves / suspends / reactivates, sets the PKR
// per-message rate, and issues a new one-time password to a locked-out
// college owner. All writes go through /api/admin/colleges.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Building2, Copy, KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import type { CollegeStatus } from '@/lib/admin/college-status';

interface College {
  id: string;
  name: string;
  status: CollegeStatus;
  createdAt: string;
  ownerEmail: string | null;
  ownerName: string | null;
  members: number;
  contacts: number;
  broadcasts: number;
  whatsapp: { connected: boolean; phoneNumberIdTail: string } | null;
  broadcastRatePkr: number | null;
}

interface Login {
  email: string;
  tempPassword: string;
}

const STATUS_VARIANT: Record<CollegeStatus, 'default' | 'secondary' | 'destructive'> = {
  active: 'default',
  pending: 'secondary',
  suspended: 'destructive',
};

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === 'string' && body.error) || fallback;
}

export function CollegesAdmin() {
  const t = useTranslations('Admin');
  const { isPlatformAdmin, profileLoading } = useAuth();

  const [colleges, setColleges] = useState<College[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [login, setLogin] = useState<{ title: string; login: Login } | null>(null);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/colleges', { cache: 'no-store' });
      if (!res.ok) {
        toast.error(await readError(res, t('loadFailed')));
        return;
      }
      const body = (await res.json()) as { colleges: College[] };
      setColleges(body.colleges);
      setRateDrafts(
        Object.fromEntries(
          body.colleges.map((c) => [c.id, c.broadcastRatePkr === null ? '' : String(c.broadcastRatePkr)]),
        ),
      );
    } catch {
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (isPlatformAdmin) void load();
  }, [isPlatformAdmin, load]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>, success: string) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/admin/colleges/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast.error(await readError(res, t('updateFailed')));
          return;
        }
        toast.success(success);
        await load();
      } catch {
        toast.error(t('networkError'));
      } finally {
        setBusyId(null);
      }
    },
    [load, t],
  );

  const resetPassword = useCallback(
    async (college: College) => {
      if (!window.confirm(t('resetConfirm', { email: college.ownerEmail ?? '' }))) return;
      setBusyId(college.id);
      try {
        const res = await fetch(`/api/admin/colleges/${college.id}/reset-password`, { method: 'POST' });
        if (!res.ok) {
          toast.error(await readError(res, t('updateFailed')));
          return;
        }
        const body = (await res.json()) as { login: Login };
        setLogin({ title: t('newPasswordTitle', { college: college.name }), login: body.login });
      } catch {
        toast.error(t('networkError'));
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  if (profileLoading) return null;
  if (!isPlatformAdmin) {
    return <p className="text-sm text-muted-foreground">{t('notAllowed')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Building2 className="h-6 w-6 text-primary" />
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {t('refresh')}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('newCollege')}
          </Button>
        </div>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="p-0">
          {colleges === null ? (
            <div className="flex items-center justify-center p-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : colleges.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('colCollege')}</TableHead>
                    <TableHead>{t('colStatus')}</TableHead>
                    <TableHead className="text-right">{t('colMembers')}</TableHead>
                    <TableHead className="text-right">{t('colContacts')}</TableHead>
                    <TableHead className="text-right">{t('colCampaigns')}</TableHead>
                    <TableHead>{t('colWhatsapp')}</TableHead>
                    <TableHead>{t('colRate')}</TableHead>
                    <TableHead className="text-right">{t('colActions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {colleges.map((c) => {
                    const busy = busyId === c.id;
                    const draft = rateDrafts[c.id] ?? '';
                    const savedRate = c.broadcastRatePkr === null ? '' : String(c.broadcastRatePkr);
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          <div className="font-medium text-foreground">{c.name}</div>
                          <div className="text-xs text-muted-foreground">{c.ownerEmail ?? '—'}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[c.status]}>{t(`status.${c.status}`)}</Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{c.members}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.contacts}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.broadcasts}</TableCell>
                        <TableCell className="text-sm">
                          {c.whatsapp
                            ? c.whatsapp.connected
                              ? t('waConnected', { tail: c.whatsapp.phoneNumberIdTail })
                              : t('waDisconnected')
                            : t('waNone')}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Input
                              aria-label={t('rateLabel', { college: c.name })}
                              className="h-8 w-24"
                              inputMode="decimal"
                              placeholder={t('ratePlaceholder')}
                              value={draft}
                              onChange={(e) => setRateDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                            />
                            {draft !== savedRate && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  void patch(c.id, { broadcastRatePkr: draft.trim() }, t('rateSaved'))
                                }
                              >
                                {t('save')}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {c.status === 'pending' && (
                              <Button size="sm" disabled={busy}
                                onClick={() => void patch(c.id, { status: 'active' }, t('approved'))}>
                                {t('approve')}
                              </Button>
                            )}
                            {c.status === 'active' && (
                              <Button size="sm" variant="outline" disabled={busy}
                                onClick={() => {
                                  if (window.confirm(t('suspendConfirm', { college: c.name }))) {
                                    void patch(c.id, { status: 'suspended' }, t('suspended'));
                                  }
                                }}>
                                {t('suspend')}
                              </Button>
                            )}
                            {c.status === 'suspended' && (
                              <Button size="sm" variant="outline" disabled={busy}
                                onClick={() => void patch(c.id, { status: 'active' }, t('reactivated'))}>
                                {t('reactivate')}
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" disabled={busy}
                              aria-label={t('resetPassword')} title={t('resetPassword')}
                              onClick={() => void resetPassword(c)}>
                              <KeyRound className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{t('rateHint')}</p>

      <CreateCollegeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(collegeName, created) => {
          setCreateOpen(false);
          setLogin({ title: t('createdTitle', { college: collegeName }), login: created });
          void load();
        }}
      />
      <LoginDialog value={login} onClose={() => setLogin(null)} />
    </div>
  );
}

function CreateCollegeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (collegeName: string, login: Login) => void;
}) {
  const t = useTranslations('Admin');
  const [collegeName, setCollegeName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/colleges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collegeName, adminName, adminEmail }),
      });
      if (!res.ok) {
        toast.error(await readError(res, t('createFailed')));
        return;
      }
      const body = (await res.json()) as { college: { name: string }; login: Login };
      setCollegeName('');
      setAdminName('');
      setAdminEmail('');
      onCreated(body.college.name, body.login);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('newCollege')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('newCollegeDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="college-name">{t('collegeName')}</Label>
            <Input id="college-name" value={collegeName} onChange={(e) => setCollegeName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-name">{t('adminName')}</Label>
            <Input id="admin-name" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-email">{t('adminEmail')}</Label>
            <Input id="admin-email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !collegeName || !adminName || !adminEmail}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LoginDialog({
  value,
  onClose,
}: {
  value: { title: string; login: Login } | null;
  onClose: () => void;
}) {
  const t = useTranslations('Admin');
  const text = value
    ? t('loginShareText', { email: value.login.email, password: value.login.tempPassword })
    : '';

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('clipboardBlocked'));
    }
  }

  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{value?.title}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('loginOnce')}</DialogDescription>
        </DialogHeader>
        {value && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-muted-foreground">{t('loginEmail')}</Label>
              <Input readOnly value={value.login.email} />
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground">{t('loginPassword')}</Label>
              <Input readOnly value={value.login.tempPassword} className="font-mono" />
            </div>
          </div>
        )}
        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={() => void copy()}>
            <Copy className="h-4 w-4" />
            {t('copy')}
          </Button>
          <Button onClick={onClose}>{t('done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
