'use client';

import { useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  dedupeByPhone,
  isUniqueViolation,
  normalizeKey,
} from '@/lib/contacts/dedupe';
import {
  parseContactCsv,
  parseContactSheet,
  type ParseContactCsvResult,
  type ParsedContactRow,
} from '@/lib/contacts/parse-contact-csv';
import { applyDefaultCountry, DEFAULT_COUNTRIES } from '@/lib/contacts/phone-default-country';
import { exclusionKey } from '@/lib/contacts/consent';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import {
  assignImportedContactTags,
  resolveImportTagIds,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags';
import {
  buildDuplicateReport,
  defaultListName,
  duplicatesCsv,
  listNameKey,
  type DuplicateRow,
  type ListMembership,
  type MatchedContact,
} from '@/lib/contacts/contact-lists';
import { fetchAllInChunks, fetchAllPages } from '@/lib/supabase/paged-query';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Tag,
  ListChecks,
  Download,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

const DEFAULT_TAG_COLOR = '#3b82f6';
const PREVIEW_LIMIT = 5;
const DUPLICATES_SHOWN = 200;

type ListMode = 'new' | 'existing' | 'none';

function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

function PreviewCell({
  value,
  mono,
  maxWidth = 'max-w-[9rem]',
}: {
  value: string;
  mono?: boolean;
  maxWidth?: string;
}) {
  return (
    <span
      className={cn(
        'block truncate',
        maxWidth,
        mono && 'font-mono text-[11px]'
      )}
      title={value}
    >
      {value}
    </span>
  );
}

function ImportPreviewTags({
  tagNames,
  tagColorByKey,
}: {
  tagNames: string[];
  tagColorByKey: Map<string, string>;
}) {
  const t = useTranslations('Contacts.importModal');

  if (tagNames.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="flex min-w-[4.5rem] flex-wrap gap-1">
      {tagNames.map((name) => {
        const color =
          tagColorByKey.get(name.trim().toLowerCase()) ?? DEFAULT_TAG_COLOR;
        const isKnown = tagColorByKey.has(name.trim().toLowerCase());
        return (
          <span
            key={name}
            className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] leading-none font-medium"
            style={{
              backgroundColor: `${color}18`,
              color,
              border: `1px solid ${color}${isKnown ? '55' : '30'}`,
            }}
            title={isKnown ? name : t('willBeCreated', { name })}
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="truncate">{name}</span>
          </span>
        );
      })}
    </div>
  );
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
}: ImportModalProps) {
  const t = useTranslations('Contacts.importModal');
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedContactRow[]>([]);
  const [hasTagsColumn, setHasTagsColumn] = useState(false);
  const [hasCompanyColumn, setHasCompanyColumn] = useState(false);
  const [tagColorByKey, setTagColorByKey] = useState<Map<string, string>>(
    new Map()
  );
  const [importing, setImporting] = useState(false);
  // Contract requirement 3: explicit default country for national-format
  // numbers, and consent attestation for the whole file.
  const [defaultCountry, setDefaultCountry] = useState<'PK' | 'none'>('PK');
  const [consentAttested, setConsentAttested] = useState(false);
  const [consentSource, setConsentSource] = useState('');
  const [consentEvidence, setConsentEvidence] = useState('');
  const [hasConsentColumn, setHasConsentColumn] = useState(false);
  // Contact lists (migration 066): each upload is saved to a list.
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [listMode, setListMode] = useState<ListMode>('new');
  const [newListName, setNewListName] = useState('');
  const [existingListId, setExistingListId] = useState('');
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    invalidPhone: number;
    failed: number;
    failedDetails: { phone: string; name?: string; reason: string }[];
    tagsAssigned: number;
    excluded: number;
    consentGranted: number;
    consentRecordedExisting: number;
    listName: string | null;
    addedToList: number;
    duplicates: DuplicateRow[];
  } | null>(null);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setHasConsentColumn(false);
    setConsentAttested(false);
    setConsentSource('');
    setConsentEvidence('');
    setHasTagsColumn(false);
    setHasCompanyColumn(false);
    setTagColorByKey(new Map());
    setListMode('new');
    setNewListName('');
    setExistingListId('');
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);
    setNewListName(defaultListName(selected.name));
    void supabase
      .from('contact_lists')
      .select('id, name')
      .order('created_at', { ascending: false })
      .then(({ data }) => setLists((data ?? []) as { id: string; name: string }[]));

    let parsed: ParseContactCsvResult;
    if (/\.xlsx$/i.test(selected.name)) {
      try {
        // Loaded on demand — only importers of Excel files pay for it.
        const { readSheet } = await import('read-excel-file/universal');
        parsed = parseContactSheet(await readSheet(selected));
      } catch (err) {
        console.error('[contacts import] could not read xlsx:', err);
        toast.error(t('toastXlsxUnreadable'));
        return;
      }
    } else {
      parsed = parseContactCsv(await selected.text());
    }
    const {
      rows,
      hasTagsColumn: csvHasTags,
      hasCompanyColumn: csvHasCompany,
    } = parsed;
    setHasConsentColumn(!!parsed.hasConsentColumn);

    if (rows.length === 0) {
      toast.error(t('toastNoValidRows'));
      setParsedRows([]);
      setHasTagsColumn(false);
      setHasCompanyColumn(false);
      setTagColorByKey(new Map());
      return;
    }

    setParsedRows(rows);
    setHasTagsColumn(csvHasTags);
    setHasCompanyColumn(csvHasCompany);

    if (csvHasTags && accountId) {
      const { data: tags } = await supabase
        .from('tags')
        .select('name, color')
        .eq('account_id', accountId);

      const colors = new Map<string, string>();
      for (const tag of tags ?? []) {
        const key = tag.name.trim().toLowerCase();
        if (!colors.has(key)) colors.set(key, tag.color);
      }
      setTagColorByKey(colors);
    } else {
      setTagColorByKey(new Map());
    }
  }

  async function handleImport() {
    if (parsedRows.length === 0) return;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error(t('notAuthenticated'));
      if (!accountId)
        throw new Error(t('notLinkedToAccount'));
      if (consentAttested && !consentSource.trim()) {
        throw new Error(t('consentSourceRequired'));
      }
      if (listMode === 'new' && !newListName.trim()) {
        throw new Error(t('listNameRequired'));
      }
      if (listMode === 'existing' && !existingListId) {
        throw new Error(t('listPickRequired'));
      }

      let imported = 0;
      let skipped = 0;
      let failed = 0;
      let excluded = 0;
      let consentGranted = 0;
      const failedDetails: { phone: string; name?: string; reason: string }[] =
        [];

      // Consent for a row: an explicit per-row `consent` value wins;
      // otherwise the file-level attestation applies; otherwise unknown
      // (imported, but not broadcastable until consent is recorded).
      const consentFor = (row: ParsedContactRow): boolean | undefined =>
        row.consent !== undefined ? row.consent : consentAttested ? true : undefined;
      const consentStamp = {
        consent_source: consentSource.trim() || null,
        consent_evidence: consentEvidence.trim() || null,
        consent_at: new Date().toISOString(),
        consent_recorded_by: user.id,
      };

      // 0) Fill in the explicitly chosen country for national numbers
      //    (e.g. 03xx… → +923xx…). Everything still has to end up as a
      //    valid international number to pass dedupeByPhone below.
      const country = defaultCountry === 'PK' ? DEFAULT_COUNTRIES.PK : null;
      const prepared = parsedRows.map((row) => ({
        ...row,
        phone: applyDefaultCountry(row.phone, country),
      }));

      // 1) De-dupe within the file by normalized phone (keep first).
      //    Rows with no usable phone at all are counted separately —
      //    they never duplicated anything, so lumping them into
      //    `skipped` would misreport them as dupes (see dedupeByPhone).
      const {
        unique,
        duplicates: inFileDupes,
        invalid: invalidPhone,
      } = dedupeByPhone(prepared);
      skipped += inFileDupes;

      // 1b) Never import a number on the do-not-message list. Paged:
      //    a single read stops at the API's 1,000-row cap.
      const exclusionRows = await fetchAllPages<{ phone_normalized: string }>((from, to) =>
        supabase
          .from('contact_exclusions')
          .select('phone_normalized')
          .eq('account_id', accountId)
          .order('phone_normalized')
          .range(from, to)
      );
      const excludedKeys = new Set(exclusionRows.map((r) => r.phone_normalized));

      // 2) Numbers already in this account aren't created again — but
      //    they are still added to this upload's list, and reported as
      //    duplicates. Paged read of the generated `phone_normalized`
      //    column (migration 022).
      const existingRows = await fetchAllPages<{
        id: string;
        phone: string;
        name: string | null;
        phone_normalized: string | null;
      }>((from, to) =>
        supabase
          .from('contacts')
          .select('id, phone, name, phone_normalized')
          .eq('account_id', accountId)
          .order('id')
          .range(from, to)
      );
      const existingByKey = new Map(
        existingRows
          .filter((r) => !!r.phone_normalized)
          .map((r) => [r.phone_normalized as string, r])
      );

      // Existing contacts this import has consent for — recorded below
      // (only where nothing is recorded yet; never over a revocation).
      const existingConsentKeys: string[] = [];
      const matched: MatchedContact[] = [];
      const newContactIds: string[] = [];
      const toInsert = unique.filter((row) => {
        const key = normalizeKey(row.phone);
        if (excludedKeys.has(exclusionKey(row.phone))) {
          excluded++;
          return false;
        }
        const found = existingByKey.get(key);
        if (found) {
          skipped++;
          matched.push({ contactId: found.id, phone: found.phone, name: found.name });
          if (consentFor(row) === true) existingConsentKeys.push(key);
          return false;
        }
        return true;
      });

      // 3) Resolve tag names → ids (admin+ may auto-create missing tags).
      //    Skip the round-trip when the import carries no tag names.
      const allTagNames = toInsert.flatMap((row) => row.tagNames);
      let tagIdByKey = new Map<string, string>();
      let skippedNames: string[] = [];
      if (allTagNames.length > 0) {
        ({ tagIdByKey, skippedNames } = await resolveImportTagIds(supabase, {
          accountId,
          userId: user.id,
          tagNames: allTagNames,
          canCreateTags: canEditSettings,
        }));
      }

      const tagAssignments: ContactTagAssignment[] = [];

      // 4) Batch insert the genuinely-new rows in chunks of 50. The DB
      //    unique index is the backstop: a 23505 (race, or a format
      //    that normalizes equal) counts as skipped, not failed.
      const chunkSize = 50;

      for (let i = 0; i < toInsert.length; i += chunkSize) {
        const chunk = toInsert.slice(i, i + chunkSize);
        const rows = chunk.map((row) => {
          const consent = consentFor(row);
          return {
            user_id: user.id,
            account_id: accountId,
            // Stored in canonical +E.164 form (dedupeByPhone already
            // proved it parses).
            phone: `+${parseInternationalPhone(row.phone)}`,
            name: row.name || null,
            email: row.email || null,
            company: row.company || null,
            ...(consent === true
              ? { consent_status: 'granted', ...consentStamp }
              : consent === false
                ? { consent_status: 'revoked', consent_source: 'import_marked_no', consent_at: consentStamp.consent_at }
                : {}),
          };
        });

        const { data, error } = await supabase
          .from('contacts')
          .insert(rows)
          .select('id');

        if (error) {
          // Retry individually so one bad/duplicate row doesn't sink
          // the whole chunk.
          for (let j = 0; j < rows.length; j++) {
            const row = rows[j];
            const source = chunk[j];
            const { data: singleData, error: singleErr } = await supabase
              .from('contacts')
              .insert(row)
              .select('id')
              .single();

            if (!singleErr && singleData) {
              imported++;
              newContactIds.push(singleData.id);
              if ('consent_status' in row && row.consent_status === 'granted') consentGranted++;
              if (source.tagNames.length > 0) {
                tagAssignments.push({
                  contactId: singleData.id,
                  tagNames: source.tagNames,
                });
              }
            } else if (isUniqueViolation(singleErr)) {
              skipped++;
            } else {
              failed++;
              // Keep the actual DB error instead of discarding it —
              // "N contacts failed" with no reason attached left no
              // way to tell an RLS/constraint failure from a fluke,
              // let alone which contact it was.
              console.error(
                '[contacts import] insert failed for',
                row.phone,
                singleErr
              );
              failedDetails.push({
                phone: row.phone,
                name: row.name ?? undefined,
                reason:
                  (singleErr as { message?: string } | null)?.message ||
                  t('unknownReason'),
              });
            }
          }
        } else {
          const inserted = data ?? [];
          imported += inserted.length;
          for (const row of inserted) newContactIds.push(row.id);
          consentGranted += rows.filter(
            (r) => 'consent_status' in r && r.consent_status === 'granted'
          ).length;
          // inserted[j] ↔ chunk[j] only holds because a single INSERT
          // preserves RETURNING order. If this path is ever split into
          // parallel inserts, zip by phone or returned id instead.
          for (let j = 0; j < inserted.length; j++) {
            const source = chunk[j];
            if (!source || source.tagNames.length === 0) continue;
            tagAssignments.push({
              contactId: inserted[j].id,
              tagNames: source.tagNames,
            });
          }
        }
      }

      // 5) Wire tags onto the contacts we just created. Failure here must
      //    not mask a successful contact import.
      let tagsAssigned = 0;
      try {
        tagsAssigned = await assignImportedContactTags(
          supabase,
          tagAssignments,
          tagIdByKey
        );
      } catch {
        toast.warning(t('toastTagsWarning'));
      }

      // 6) Contacts that already existed: record this import's consent
      //    where none is recorded yet. Never overwrites a revocation (and
      //    the DB refuses to re-grant an excluded number anyway).
      let consentRecordedExisting = 0;
      for (let i = 0; i < existingConsentKeys.length; i += 200) {
        const keys = existingConsentKeys.slice(i, i + 200);
        const { data: updated, error: consentErr } = await supabase
          .from('contacts')
          .update({ consent_status: 'granted', ...consentStamp })
          .eq('account_id', accountId)
          .eq('consent_status', 'unknown')
          .in('phone_normalized', keys)
          .select('id');
        if (consentErr) {
          console.error('[contacts import] consent update failed:', consentErr);
          toast.warning(t('toastConsentUpdateFailed'));
          break;
        }
        consentRecordedExisting += updated?.length ?? 0;
      }

      // 7) Save this upload to its list and report the numbers that
      //    were already contacts, with the lists they're already in.
      //    A failure here must not mask a successful import.
      let targetListId: string | null = null;
      let listName: string | null = null;
      let addedToList = 0;
      let duplicates: DuplicateRow[] = [];
      try {
        if (listMode === 'existing') {
          targetListId = existingListId;
          listName = lists.find((l) => l.id === existingListId)?.name ?? null;
        } else if (listMode === 'new') {
          const name = newListName.trim();
          const { data: created, error: listErr } = await supabase
            .from('contact_lists')
            .insert({ account_id: accountId, name, created_by: user.id })
            .select('id, name')
            .single();
          if (created) {
            targetListId = created.id;
            listName = created.name;
          } else if (isUniqueViolation(listErr)) {
            // A list with this name exists — add to it.
            const { data: all } = await supabase.from('contact_lists').select('id, name');
            const same = (all ?? []).find((l) => listNameKey(l.name) === listNameKey(name));
            if (!same) throw listErr;
            targetListId = same.id;
            listName = same.name;
          } else {
            throw listErr;
          }
        }

        const memberships: ListMembership[] = (
          await fetchAllInChunks<
            { contact_id: string; list_id: string; contact_lists: { name: string } | { name: string }[] | null },
            string
          >(
            matched.map((m) => m.contactId),
            (slice, from, to) =>
              supabase
                .from('contact_list_members')
                .select('contact_id, list_id, contact_lists(name)')
                .in('contact_id', slice)
                .order('contact_id')
                .order('list_id')
                .range(from, to)
          )
        ).map((m) => {
          const list = Array.isArray(m.contact_lists) ? m.contact_lists[0] : m.contact_lists;
          return { contactId: m.contact_id, listId: m.list_id, listName: list?.name ?? '' };
        });
        duplicates = buildDuplicateReport(matched, memberships, targetListId);

        if (targetListId) {
          const listId = targetListId;
          const ids = [...new Set([...newContactIds, ...matched.map((m) => m.contactId)])];
          for (let i = 0; i < ids.length; i += 500) {
            const { error: memberErr } = await supabase
              .from('contact_list_members')
              .upsert(
                ids.slice(i, i + 500).map((contactId) => ({ list_id: listId, contact_id: contactId })),
                { onConflict: 'list_id,contact_id', ignoreDuplicates: true }
              );
            if (memberErr) throw memberErr;
          }
          addedToList = ids.length;
        }
      } catch (listErr) {
        console.error('[contacts import] list step failed:', listErr);
        toast.warning(t('toastListFailed'));
      }

      setResult({
        imported,
        skipped,
        invalidPhone,
        failed,
        failedDetails,
        tagsAssigned,
        excluded,
        consentGranted,
        consentRecordedExisting,
        listName,
        addedToList,
        duplicates,
      });
      if (imported > 0) {
        toast.success(t('toastImported', { count: imported }));
      }
      if (imported > 0 || addedToList > 0) onImported();
      if (tagsAssigned > 0) {
        toast.success(t('toastTagsAssigned', { count: tagsAssigned }));
      }
      if (skippedNames.length > 0) {
        const sample = skippedNames.slice(0, 3).join(', ');
        const more =
          skippedNames.length > 3 ? t('toastTagsSkippedMore', { count: skippedNames.length - 3 }) : '';
        toast.info(t('toastTagsSkipped', { sample, more }));
      }
      if (skipped > 0) {
        toast.info(t('toastSkipped', { count: skipped }));
      }
      if (invalidPhone > 0) {
        toast.warning(t('toastInvalidPhone', { count: invalidPhone }));
      }
      if (failed > 0) {
        toast.error(t('toastFailed', { count: failed }));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = parsedRows.slice(0, PREVIEW_LIMIT);
  // Tags: OR — show when the CSV declares a column or preview rows carry
  // values, so an all-empty tags column still renders for validation.
  const previewHasTags =
    hasTagsColumn || preview.some((row) => row.tagNames.length > 0);
  // Company: AND — hide unless the CSV declares it and preview has data,
  // avoiding an all-dash column that wastes horizontal space.
  const previewHasCompany =
    hasCompanyColumn && preview.some((row) => row.company?.trim());

  const tagStats = useMemo(() => {
    const names = new Set<string>();
    let rowsWithTags = 0;
    for (const row of parsedRows) {
      if (row.tagNames.length === 0) continue;
      rowsWithTags++;
      for (const name of row.tagNames) names.add(name.trim().toLowerCase());
    }
    return { unique: names.size, rowsWithTags };
  }, [parsedRows]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-muted-foreground"
              dangerouslySetInnerHTML={{
                __html: t.markup('desc', {
                  phoneCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  nameCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  emailCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  companyCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                  tagsCode: (chunks) => `<code class="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">${chunks}</code>`,
                })
              }}
            />
          </DialogHeader>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ')
                fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'hover:border-primary/40 border-border/80 bg-background/40 hover:bg-background/70'
            )}
          >
            {file ? (
              <>
                <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
                  <FileText className="text-primary size-5" />
                </div>
                <p
                  className="max-w-full truncate px-2 text-sm font-medium text-popover-foreground"
                  title={file.name}
                >
                  {truncateFilename(file.name)}
                </p>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {t('rowsReady', { count: parsedRows.length })}
                </span>
              </>
            ) : (
              <>
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
                  <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('uploadDropzone')}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {t('uploadHint')}
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleFileChange}
            className="hidden"
          />

          {parsedRows.length > 0 && !result && (
            <div className="space-y-3 rounded-xl border border-border/80 bg-background/40 p-3 text-sm">
              <label className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{t('defaultCountryLabel')}</span>
                <select
                  value={defaultCountry}
                  onChange={(e) => setDefaultCountry(e.target.value as 'PK' | 'none')}
                  className="rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                >
                  <option value="PK">{t('defaultCountryPK')}</option>
                  <option value="none">{t('defaultCountryNone')}</option>
                </select>
              </label>

              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={consentAttested}
                  onChange={(e) => setConsentAttested(e.target.checked)}
                />
                <span className="text-popover-foreground">{t('consentAttest')}</span>
              </label>
              {consentAttested && (
                <div className="grid gap-2 pl-6 sm:grid-cols-2">
                  <input
                    aria-label={t('consentSourceLabel')}
                    placeholder={t('consentSourcePlaceholder')}
                    value={consentSource}
                    onChange={(e) => setConsentSource(e.target.value)}
                    className="rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                  />
                  <input
                    aria-label={t('consentEvidenceLabel')}
                    placeholder={t('consentEvidencePlaceholder')}
                    value={consentEvidence}
                    onChange={(e) => setConsentEvidence(e.target.value)}
                    className="rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {hasConsentColumn ? t('consentColumnHint') : t('consentHint')}
              </p>

              <div className="space-y-2 border-t border-border/80 pt-3">
                <label className="flex flex-wrap items-center gap-2">
                  <ListChecks className="size-4 text-primary" />
                  <span className="text-muted-foreground">{t('listLabel')}</span>
                  <select
                    value={listMode}
                    onChange={(e) => setListMode(e.target.value as ListMode)}
                    className="rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                  >
                    <option value="new">{t('listModeNew')}</option>
                    <option value="existing" disabled={lists.length === 0}>{t('listModeExisting')}</option>
                    <option value="none">{t('listModeNone')}</option>
                  </select>
                </label>
                {listMode === 'new' && (
                  <input
                    aria-label={t('listNameLabel')}
                    placeholder={t('listNameLabel')}
                    value={newListName}
                    maxLength={120}
                    onChange={(e) => setNewListName(e.target.value)}
                    className="w-full rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                  />
                )}
                {listMode === 'existing' && (
                  <select
                    aria-label={t('listPickLabel')}
                    value={existingListId}
                    onChange={(e) => setExistingListId(e.target.value)}
                    className="w-full rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                  >
                    <option value="">{t('listPickLabel')}</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-muted-foreground">{t('listHint')}</p>
              </div>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {preview.length > 0 && !result && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  {t('preview', { count: preview.length })}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tagStats.rowsWithTags > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted/90 px-2 py-0.5 text-[11px] text-muted-foreground">
                      <Tag className="text-primary/80 size-3" />
                      {t('previewTags', { tags: tagStats.unique, contacts: tagStats.rowsWithTags })}
                    </span>
                  )}
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-border ring-1 ring-border/50">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-xs">
                    <thead>
                      <tr className="border-b border-border bg-background/60">
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          {t('columns.phone')}
                        </th>
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          {t('columns.name')}
                        </th>
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          {t('columns.email')}
                        </th>
                        {previewHasCompany && (
                          <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                            {t('columns.company')}
                          </th>
                        )}
                        {previewHasTags && (
                          <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                            {t('columns.tags')}
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {preview.map((row, i) => (
                        <tr
                          key={i}
                          className="bg-popover/40 transition-colors hover:bg-muted/30"
                        >
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                            <PreviewCell
                              value={row.phone}
                              mono
                              maxWidth="max-w-[7.5rem]"
                            />
                          </td>
                          <td className="px-3 py-2 text-popover-foreground">
                            <PreviewCell
                              value={row.name || '—'}
                              maxWidth="max-w-[8.5rem]"
                            />
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            <PreviewCell
                              value={row.email || '—'}
                              maxWidth="max-w-[10rem]"
                            />
                          </td>
                          {previewHasCompany && (
                            <td className="px-3 py-2 text-muted-foreground">
                              <PreviewCell
                                value={row.company || '—'}
                                maxWidth="max-w-[7rem]"
                              />
                            </td>
                          )}
                          {previewHasTags && (
                            <td className="px-3 py-2 align-top">
                              <ImportPreviewTags
                                tagNames={row.tagNames}
                                tagColorByKey={tagColorByKey}
                              />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {parsedRows.length > PREVIEW_LIMIT && (
                <p className="text-center text-[11px] text-muted-foreground">
                  {t('moreRows', { count: parsedRows.length - PREVIEW_LIMIT })}
                </p>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <p className="text-sm font-medium text-popover-foreground">{t('importComplete')}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                {result.imported > 0 && (
                  <div className="text-primary flex items-center gap-1.5 text-sm">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultImported', { count: result.imported })}
                  </div>
                )}
                {result.tagsAssigned > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-cyan-400">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultTags', { count: result.tagsAssigned })}
                  </div>
                )}
                {result.skipped > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultSkipped', { count: result.skipped })}
                  </div>
                )}
                {result.invalidPhone > 0 && (
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 text-sm text-amber-400">
                      <AlertTriangle className="size-4 shrink-0" />
                      {t('resultInvalidPhone', { count: result.invalidPhone })}
                    </div>
                    <p className="pl-[1.375rem] text-xs text-muted-foreground">
                      {t('invalidPhoneHint')}
                    </p>
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="size-4 shrink-0" />
                    {t('resultFailed', { count: result.failed })}
                  </div>
                )}
                {result.excluded > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultExcluded', { count: result.excluded })}
                  </div>
                )}
                {result.consentGranted + result.consentRecordedExisting > 0 && (
                  <div className="text-primary flex items-center gap-1.5 text-sm">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultConsent', { count: result.consentGranted + result.consentRecordedExisting })}
                  </div>
                )}
              </div>
              {result.imported > result.consentGranted && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('resultNoConsentHint', { count: result.imported - result.consentGranted })}
                </p>
              )}

              {result.listName && result.addedToList > 0 && (
                <p className="text-primary mt-3 flex items-center gap-1.5 text-sm">
                  <ListChecks className="size-4 shrink-0" />
                  {t('resultList', { count: result.addedToList, list: result.listName })}
                </p>
              )}

              {result.duplicates.length > 0 && (
                <DuplicatesReport rows={result.duplicates} fileName={file?.name ?? 'contacts'} />
              )}

              {result.failedDetails.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-border/80 pt-3">
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    {t('failedRowsHeading')}
                  </p>
                  <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                    {result.failedDetails.map((row, i) => (
                      <li
                        key={i}
                        className="flex items-baseline gap-2 text-muted-foreground"
                      >
                        <span className="shrink-0 font-mono text-popover-foreground">
                          {row.name ? `${row.name} (${row.phone})` : row.phone}
                        </span>
                        <span className="truncate">{row.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={
                parsedRows.length === 0 ||
                importing ||
                (consentAttested && !consentSource.trim()) ||
                (listMode === 'new' && !newListName.trim()) ||
                (listMode === 'existing' && !existingListId)
              }
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              {parsedRows.length > 0 ? t('importBtn', { count: parsedRows.length }) : t('importBtn', { count: 0 })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Numbers in the upload that were already contacts, and their lists. */
function DuplicatesReport({ rows, fileName }: { rows: DuplicateRow[]; fileName: string }) {
  const t = useTranslations('Contacts.importModal');
  const inOtherLists = rows.filter((r) => r.otherLists.length > 0).length;

  function download() {
    const csv = duplicatesCsv(rows, [t('dupColPhone'), t('dupColName'), t('dupColLists')]);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `duplicates - ${defaultListName(fileName)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-3 space-y-2 border-t border-border/80 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-popover-foreground">
            {t('dupTitle', { count: rows.length })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('dupSummary', { inLists: inOtherLists, count: rows.length })}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={download}>
          <Download className="size-4" />
          {t('dupDownload')}
        </Button>
      </div>
      <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-border">
              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">{t('dupColPhone')}</th>
              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">{t('dupColName')}</th>
              <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">{t('dupColLists')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.slice(0, DUPLICATES_SHOWN).map((r) => (
              <tr key={r.phone}>
                <td className="px-3 py-1.5 font-mono text-[11px] whitespace-nowrap text-popover-foreground">{r.phone}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.name || '—'}</td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {r.otherLists.length > 0
                    ? r.otherLists.join(', ')
                    : r.inTargetList
                      ? t('dupAlreadyInThisList')
                      : t('dupNoList')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > DUPLICATES_SHOWN && (
        <p className="text-[11px] text-muted-foreground">
          {t('dupMore', { count: rows.length - DUPLICATES_SHOWN })}
        </p>
      )}
    </div>
  );
}
