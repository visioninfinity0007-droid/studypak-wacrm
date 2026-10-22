'use client';

// Opt-out / exclusion list (contract requirement 3). Numbers here never
// receive broadcasts. STOP replies add themselves automatically; staff can
// add a number by hand. Removing one is admin-only (RLS enforces it).

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Ban, Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { applyDefaultCountry, DEFAULT_COUNTRIES } from '@/lib/contacts/phone-default-country';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

interface Exclusion {
  id: string;
  phone_normalized: string;
  reason: 'opt_out' | 'manual';
  note: string | null;
  created_at: string;
}

export function ExclusionsDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Contacts.exclusions');
  const supabase = createClient();
  const { accountId, user } = useAuth();
  const canAdd = useCan('send-messages');
  const canRemove = useCan('edit-settings');
  const [rows, setRows] = useState<Exclusion[] | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('contact_exclusions')
      .select('id, phone_normalized, reason, note, created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      toast.error(t('loadFailed'));
      return;
    }
    setRows((data ?? []) as Exclusion[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function add() {
    const digits = parseInternationalPhone(applyDefaultCountry(phone, DEFAULT_COUNTRIES.PK));
    if (!digits || !accountId) {
      toast.error(t('invalidPhone'));
      return;
    }
    setBusy(true);
    const { error } = await supabase.from('contact_exclusions').insert({
      account_id: accountId,
      phone_normalized: digits,
      reason: 'manual',
      note: 'Added by staff',
      created_by: user?.id ?? null,
    });
    setBusy(false);
    if (error && error.code !== '23505') {
      toast.error(t('addFailed'));
      return;
    }
    toast.success(t('added'));
    setPhone('');
    await load();
    onChanged();
  }

  async function remove(row: Exclusion) {
    if (!window.confirm(t('removeConfirm', { phone: `+${row.phone_normalized}` }))) return;
    setBusy(true);
    const { data, error } = await supabase.from('contact_exclusions').delete().eq('id', row.id).select('id');
    setBusy(false);
    if (error || !data?.length) {
      toast.error(t('removeFailed'));
      return;
    }
    toast.success(t('removed'));
    await load();
    onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <Ban className="h-5 w-5 text-primary" />
            {t('title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('desc')}</DialogDescription>
        </DialogHeader>

        {canAdd && (
          <div className="flex gap-2">
            <Input placeholder={t('phonePlaceholder')} value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Button onClick={() => void add()} disabled={busy || !phone.trim()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('add')}
            </Button>
          </div>
        )}

        <div className="max-h-80 overflow-y-auto rounded-md border border-border">
          {rows === null ? (
            <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div>
                    <div className="font-mono text-foreground">+{row.phone_normalized}</div>
                    <div className="text-xs text-muted-foreground">
                      {t(`reason.${row.reason}`)} · {new Date(row.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  {canRemove && (
                    <Button variant="ghost" size="sm" disabled={busy} aria-label={t('remove')} title={t('remove')}
                      onClick={() => void remove(row)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
