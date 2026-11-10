'use client';

import { useEffect, useState } from 'react';
import { countAlreadySent, countAudience, type AudienceConfig } from '@/lib/broadcast-audience';
import {
  SCHEDULE_MIN_LEAD_MS,
  checkScheduledAt,
  scheduleFromDelay,
  type DelayUnit,
} from '@/lib/broadcast-schedule';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { estimateBroadcastCost } from '@/lib/broadcast-cost';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { AlertTriangle, ArrowLeft, Send, Loader2, Users, Save, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Local "YYYY-MM-DDTHH:mm" for a datetime-local input. */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  /** Also send to students who already received this template. */
  resendAlreadySent: boolean;
  onResendAlreadySentChange: (resend: boolean) => void;
  /** No argument: send now. An ISO time: schedule for then. */
  onSend: (scheduledAt?: string) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  resendAlreadySent,
  onResendAlreadySentChange,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const { accountId } = useAuth();
  const [ratePkr, setRatePkr] = useState<number | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const [loadingRate, setLoadingRate] = useState(true);
  const [showConfirm, setShowConfirm] = useState(false);
  // When to send. "later" is either a delay from the moment the button
  // is pressed ("after 3 hours") or a fixed local date and time.
  const [sendMode, setSendMode] = useState<'now' | 'later'>('now');
  const [laterKind, setLaterKind] = useState<'delay' | 'exact'>('delay');
  const [delayAmount, setDelayAmount] = useState('1');
  const [delayUnit, setDelayUnit] = useState<DelayUnit>('hours');
  const [exactValue, setExactValue] = useState(() => toLocalInputValue(Date.now() + 60 * 60_000));
  // Re-read the clock every 30 s so the "will send on" line stays true
  // for a delay while the page sits open.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  // Students in this audience who already received this template —
  // skipped unless the box below is ticked. null while counting.
  const [alreadySent, setAlreadySent] = useState<{ key: string; count: number } | null>(null);
  const alreadySentKey = `${template.name}|${JSON.stringify(audience)}`;
  const alreadySentCount = alreadySent?.key === alreadySentKey ? alreadySent.count : null;

  useEffect(() => {
    let cancelled = false;
    countAlreadySent(createClient(), audience, template.name)
      .then((count) => {
        if (!cancelled) setAlreadySent({ key: alreadySentKey, count });
      })
      .catch(() => {
        if (!cancelled) setAlreadySent({ key: alreadySentKey, count: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [audience, template.name, alreadySentKey]);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        setEstimatedReach((await countAudience(createClient(), audience)) ?? 0);
      } catch {
        setEstimatedReach(0);
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  useEffect(() => {
    let active = true;
    async function loadRate() {
      if (!accountId) return;
      setLoadingRate(true);
      const { data, error } = await createClient()
        .from('accounts')
        .select('broadcast_rate_pkr')
        .eq('id', accountId)
        .single();
      if (!active) return;
      if (error) {
        setRateError('Unable to load cost configuration; verify migration 060.');
      } else {
        const value = data?.broadcast_rate_pkr;
        const rate = value === null || value === undefined ? null : Number(value);
        setRatePkr(rate);
        setRateError(null);
      }
      setLoadingRate(false);
    }
    void loadRate();
    return () => { active = false; };
  }, [accountId]);

  const skipped = resendAlreadySent ? 0 : alreadySentCount ?? 0;
  const sendReach = Math.max(0, estimatedReach - skipped);
  const costEstimate = loadingReach || loadingRate || alreadySentCount === null
    ? null
    : estimateBroadcastCost(sendReach, ratePkr);
  const costIsConfigured = ratePkr !== null && !loadingRate && !rateError;

  // The send time the current choices produce, against `at` (ms).
  function scheduledTimeAt(at: number): Date | null {
    if (laterKind === 'delay') {
      const amount = Number(delayAmount);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return scheduleFromDelay(amount, delayUnit, at);
    }
    const ms = Date.parse(exactValue); // datetime-local → browser's local time
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  const previewTime = sendMode === 'later' ? scheduledTimeAt(clock) : null;
  const scheduleCheck = sendMode === 'later'
    ? checkScheduledAt(previewTime ?? 'invalid', clock)
    : null;
  const scheduleError = scheduleCheck && !scheduleCheck.ok
    ? {
        invalid: t('scheduleSend.errInvalid'),
        too_soon: t('scheduleSend.errTooSoon'),
        too_far: t('scheduleSend.errTooFar'),
      }[scheduleCheck.reason]
    : null;
  const canSubmit = Boolean(name.trim()) && !isProcessing && costIsConfigured && !scheduleError;
  const formatTime = (d: Date) =>
    d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'lists'
          ? t('scheduleSend.audienceLists')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{sendReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Already received this template: skipped unless ticked. */}
      {alreadySentCount !== null && alreadySentCount > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-sm text-foreground">
              {t('scheduleSend.alreadySent', { count: alreadySentCount, template: template.name })}
            </p>
          </div>
          <label className="flex items-center gap-2 pl-6 text-sm text-foreground">
            <input
              type="checkbox"
              checked={resendAlreadySent}
              onChange={(e) => onResendAlreadySentChange(e.target.checked)}
            />
            {t('scheduleSend.resendAlreadySent', { count: alreadySentCount })}
          </label>
          <p className="pl-6 text-xs text-muted-foreground">
            {resendAlreadySent ? t('scheduleSend.resendOn') : t('scheduleSend.resendOff')}
          </p>
        </div>
      )}

      {/* When to send */}
      <div className="space-y-3 rounded-xl border border-border p-4">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.whenTitle')}</p>
        <div className="flex flex-wrap gap-4 text-sm text-foreground">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="send-mode"
              checked={sendMode === 'now'}
              onChange={() => setSendMode('now')}
              disabled={isProcessing}
            />
            {t('scheduleSend.optionNow')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="send-mode"
              checked={sendMode === 'later'}
              onChange={() => setSendMode('later')}
              disabled={isProcessing}
            />
            {t('scheduleSend.optionLater')}
          </label>
        </div>

        {sendMode === 'later' && (
          <div className="space-y-3 border-t border-border pt-3">
            <div className="flex flex-wrap gap-4 text-sm text-foreground">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="later-kind"
                  checked={laterKind === 'delay'}
                  onChange={() => setLaterKind('delay')}
                  disabled={isProcessing}
                />
                {t('scheduleSend.afterDelay')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="later-kind"
                  checked={laterKind === 'exact'}
                  onChange={() => setLaterKind('exact')}
                  disabled={isProcessing}
                />
                {t('scheduleSend.atTime')}
              </label>
            </div>

            {laterKind === 'delay' ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                <span>{t('scheduleSend.delayPrefix')}</span>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={delayAmount}
                  onChange={(e) => setDelayAmount(e.target.value)}
                  disabled={isProcessing}
                  aria-label={t('scheduleSend.delayAmount')}
                  className="w-24 border-border bg-muted text-foreground"
                />
                <select
                  value={delayUnit}
                  onChange={(e) => setDelayUnit(e.target.value as DelayUnit)}
                  disabled={isProcessing}
                  aria-label={t('scheduleSend.delayUnit')}
                  className="h-9 rounded-md border border-border bg-muted px-2 text-foreground"
                >
                  <option value="minutes">{t('scheduleSend.unitMinutes')}</option>
                  <option value="hours">{t('scheduleSend.unitHours')}</option>
                  <option value="days">{t('scheduleSend.unitDays')}</option>
                </select>
              </div>
            ) : (
              <Input
                type="datetime-local"
                value={exactValue}
                min={toLocalInputValue(clock + SCHEDULE_MIN_LEAD_MS)}
                onChange={(e) => setExactValue(e.target.value)}
                disabled={isProcessing}
                aria-label={t('scheduleSend.atTime')}
                className="w-fit border-border bg-muted text-foreground"
              />
            )}

            {scheduleError ? (
              <p role="alert" className="text-sm text-destructive">{scheduleError}</p>
            ) : previewTime ? (
              <p className="flex items-center gap-1.5 text-sm text-foreground">
                <Clock className="h-3.5 w-3.5 text-primary" />
                {t('scheduleSend.willSendAt', { time: formatTime(previewTime) })}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('scheduleSend.scheduleHint')}</p>
          </div>
        )}
      </div>

      {/* Indicative pricing: a configurable rate, not Meta's live rate card. */}
      <div className="space-y-2 rounded-xl border border-border p-4">
        <p className="text-sm font-medium text-foreground">Estimated broadcast cost (PKR)</p>
        <p className="text-xl font-semibold text-foreground">
          {costEstimate === null ? 'Not configured' :
            `PKR ${costEstimate.toLocaleString('en-PK', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}
        </p>
        <p className="text-xs text-muted-foreground">
          Indicative cost at a platform-configured per-message rate. Actual Meta charges
          depend on recipient country, template category and delivered messages.
        </p>
        {rateError && <p role="alert" className="text-sm text-destructive">{rateError}</p>}
        {!costIsConfigured && <p className="text-xs text-destructive">
          The platform administrator must configure a rate before sending.
        </p>}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">
                {sendMode === 'later' ? t('scheduleSend.scheduling') : t('scheduleSend.sending')}
              </p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!canSubmit}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {sendMode === 'later' ? <Clock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {sendMode === 'later' ? t('scheduleSend.scheduleButton') : t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {sendMode === 'later' ? t('scheduleSend.confirmScheduleTitle') : t('scheduleSend.confirmTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {sendMode === 'later' && previewTime
                  ? t.rich('scheduleSend.confirmScheduleDesc', {
                      count: sendReach,
                      template: template.name,
                      time: formatTime(previewTime),
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })
                  : t.rich('scheduleSend.confirmDesc', {
                      count: sendReach,
                      template: template.name,
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                disabled={!canSubmit}
                onClick={() => {
                  if (!canSubmit) return;
                  setShowConfirm(false);
                  if (sendMode === 'now') {
                    onSend();
                    return;
                  }
                  // A delay counts from this click, not from when the page
                  // opened; recheck in case the time slipped past the limit.
                  const at = scheduledTimeAt(Date.now());
                  const check = checkScheduledAt(at ?? 'invalid', Date.now());
                  if (!check.ok) {
                    setClock(Date.now());
                    return;
                  }
                  onSend(check.iso);
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {sendMode === 'later' ? <Clock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {sendMode === 'later' ? t('scheduleSend.scheduleButton') : t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
