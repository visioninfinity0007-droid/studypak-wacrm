'use client';

// Contact lists (migration 066): see every list with its size, rename
// one, or delete one. Deleting asks whether to also delete the contacts
// that are in no other list (delete_contact_list RPC, admin-only).

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

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
import { createClient } from '@/lib/supabase/client';
import { useCan } from '@/hooks/use-can';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

export interface ContactListSummary {
  id: string;
  name: string;
  size: number;
  createdAt: string;
}

/** Every list in the caller's college, newest first, with its size. */
export async function loadContactLists(): Promise<ContactListSummary[]> {
  const { data, error } = await createClient()
    .from('contact_lists')
    .select('id, name, created_at, contact_list_members(count)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as {
    id: string;
    name: string;
    created_at: string;
    contact_list_members: { count: number }[];
  }[]).map((l) => ({
    id: l.id,
    name: l.name,
    size: l.contact_list_members?.[0]?.count ?? 0,
    createdAt: l.created_at,
  }));
}

export function ListsDialog({
  open,
  onOpenChange,
  lists,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: ContactListSummary[];
  /** A list was renamed or deleted (and maybe contacts with it). */
  onChanged: () => void;
}) {
  const t = useTranslations('Contacts.lists');
  const format = useFormatter();
  const canEdit = useCan('send-messages');
  const canDelete = useCan('edit-settings');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContactListSummary | null>(null);

  async function rename() {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    setSaving(true);
    const { error } = await createClient().from('contact_lists').update({ name }).eq('id', editing.id);
    setSaving(false);
    if (error) {
      toast.error(isUniqueViolation(error) ? t('nameTaken') : t('renameFailed'));
      return;
    }
    toast.success(t('renamed'));
    setEditing(null);
    onChanged();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t('desc')}</DialogDescription>
          </DialogHeader>
          {lists.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {lists.map((l) => (
                <li key={l.id} className="flex items-center gap-2 px-3 py-2">
                  {editing?.id === l.id ? (
                    <>
                      <Input
                        autoFocus
                        aria-label={t('nameLabel')}
                        value={editing.name}
                        maxLength={120}
                        onChange={(e) => setEditing({ id: l.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void rename();
                          if (e.key === 'Escape') setEditing(null);
                        }}
                        className="h-8"
                      />
                      <Button size="sm" variant="ghost" disabled={saving || !editing.name.trim()}
                        aria-label={t('save')} onClick={() => void rename()}>
                        {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={t('cancel')} onClick={() => setEditing(null)}>
                        <X className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-popover-foreground">{l.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('meta', {
                            count: l.size,
                            date: format.dateTime(new Date(l.createdAt), { dateStyle: 'medium' }),
                          })}
                        </p>
                      </div>
                      {canEdit && (
                        <Button size="sm" variant="ghost" aria-label={t('rename', { name: l.name })}
                          title={t('rename', { name: l.name })}
                          onClick={() => setEditing({ id: l.id, name: l.name })}>
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      {canDelete && (
                        <Button size="sm" variant="ghost" aria-label={t('delete', { name: l.name })}
                          title={t('delete', { name: l.name })}
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(l)}>
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <DialogFooter className="bg-popover border-border">
            <Button onClick={() => onOpenChange(false)}>{t('done')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteListDialog
        list={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          onChanged();
        }}
      />
    </>
  );
}

function DeleteListDialog({
  list,
  onClose,
  onDeleted,
}: {
  list: ContactListSummary | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('Contacts.lists');
  const [alsoContacts, setAlsoContacts] = useState(false);
  const [onlyHere, setOnlyHere] = useState<{ id: string; count: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const onlyHereCount = list && onlyHere?.id === list.id ? onlyHere.count : null;

  // How many of the list's contacts are in no other list — the ones the
  // checkbox would delete.
  const countOnlyHere = useCallback(async (target: ContactListSummary) => {
    const db = createClient();
    const { data: members } = await db
      .from('contact_list_members')
      .select('contact_id')
      .eq('list_id', target.id)
      .limit(10000);
    const ids = (members ?? []).map((m: { contact_id: string }) => m.contact_id);
    const elsewhere = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await db
        .from('contact_list_members')
        .select('contact_id')
        .in('contact_id', ids.slice(i, i + 100))
        .neq('list_id', target.id);
      for (const row of data ?? []) elsewhere.add((row as { contact_id: string }).contact_id);
    }
    return ids.filter((id) => !elsewhere.has(id)).length;
  }, []);

  useEffect(() => {
    if (!list) return;
    let cancelled = false;
    void countOnlyHere(list).then((count) => {
      if (!cancelled) setOnlyHere({ id: list.id, count });
    });
    return () => {
      cancelled = true;
    };
  }, [list, countOnlyHere]);

  async function remove() {
    if (!list) return;
    setDeleting(true);
    const { data, error } = await createClient().rpc('delete_contact_list', {
      p_list_id: list.id,
      p_delete_contacts: alsoContacts,
    });
    setDeleting(false);
    if (error) {
      toast.error(error.code === '42501' ? t('adminOnly') : t('deleteFailed'));
      return;
    }
    toast.success(
      alsoContacts ? t('deletedWithContacts', { name: list.name, count: Number(data ?? 0) }) : t('deleted', { name: list.name }),
    );
    setAlsoContacts(false);
    onDeleted();
  }

  return (
    <Dialog
      open={!!list}
      onOpenChange={(o) => {
        if (!o) {
          setAlsoContacts(false);
          onClose();
        }
      }}
    >
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('deleteTitle', { name: list?.name ?? '' })}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('deleteDesc', { count: list?.size ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={alsoContacts}
            disabled={onlyHereCount === 0}
            onChange={(e) => setAlsoContacts(e.target.checked)}
          />
          <span>
            {onlyHereCount === null ? (
              <Loader2 className="inline size-3 animate-spin" />
            ) : (
              t('alsoDeleteContacts', { count: onlyHereCount })
            )}
            <span className="mt-1 block text-xs text-muted-foreground">{t('alsoDeleteHint')}</span>
          </span>
        </label>
        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            {t('cancel')}
          </Button>
          <Button variant="destructive" onClick={() => void remove()} disabled={deleting}>
            {deleting && <Loader2 className="size-4 animate-spin" />}
            {alsoContacts ? t('deleteListAndContacts') : t('deleteListOnly')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
