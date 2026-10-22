'use client';

// Record broadcast consent with its evidence (contract requirement 3)
// for the selected contacts, or for every contact that has none recorded
// yet. Never overrides a revocation: opted-out / excluded contacts stay
// revoked (the database also refuses to re-grant an excluded number).

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
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
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';

interface RecordConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Selected contact ids; empty → offer "all without consent" only. */
  selectedIds: string[];
  onDone: () => void;
}

export function RecordConsentDialog({ open, onOpenChange, selectedIds, onDone }: RecordConsentDialogProps) {
  const t = useTranslations('Contacts.consent');
  const supabase = createClient();
  const { accountId, user } = useAuth();
  const [scope, setScope] = useState<'selected' | 'all_unknown'>('selected');
  const [source, setSource] = useState('');
  const [evidence, setEvidence] = useState('');
  const [unknownCount, setUnknownCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !accountId) return;
    setScope(selectedIds.length > 0 ? 'selected' : 'all_unknown');
    void supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('consent_status', 'unknown')
      .then(({ count }) => setUnknownCount(count ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId, selectedIds.length]);

  async function submit() {
    if (!accountId || !user || !source.trim()) return;
    setSaving(true);
    const stamp = {
      consent_status: 'granted',
      consent_source: source.trim(),
      consent_evidence: evidence.trim() || null,
      consent_at: new Date().toISOString(),
      consent_recorded_by: user.id,
    };
    try {
      let updated = 0;
      if (scope === 'selected') {
        for (let i = 0; i < selectedIds.length; i += 200) {
          const { data, error } = await supabase
            .from('contacts')
            .update(stamp)
            .eq('account_id', accountId)
            .neq('consent_status', 'revoked')
            .in('id', selectedIds.slice(i, i + 200))
            .select('id');
          if (error) throw error;
          updated += data?.length ?? 0;
        }
      } else {
        const { data, error } = await supabase
          .from('contacts')
          .update(stamp)
          .eq('account_id', accountId)
          .eq('consent_status', 'unknown')
          .select('id');
        if (error) throw error;
        updated = data?.length ?? 0;
      }
      toast.success(t('toastRecorded', { count: updated }));
      setSource('');
      setEvidence('');
      onOpenChange(false);
      onDone();
    } catch (err) {
      console.error('[record consent] failed:', err);
      toast.error(t('toastFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {t('title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('desc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="space-y-2">
            {selectedIds.length > 0 && (
              <label className="flex items-center gap-2">
                <input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} />
                {t('scopeSelected', { count: selectedIds.length })}
              </label>
            )}
            <label className="flex items-center gap-2">
              <input type="radio" checked={scope === 'all_unknown'} onChange={() => setScope('all_unknown')} />
              {unknownCount === null ? t('scopeAllUnknownLoading') : t('scopeAllUnknown', { count: unknownCount })}
            </label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="consent-source">{t('sourceLabel')}</Label>
            <Input id="consent-source" placeholder={t('sourcePlaceholder')} value={source}
              onChange={(e) => setSource(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="consent-evidence">{t('evidenceLabel')}</Label>
            <Input id="consent-evidence" placeholder={t('evidencePlaceholder')} value={evidence}
              onChange={(e) => setEvidence(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">{t('revokedNote')}</p>
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !source.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('record')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
