"use client";

// Export and delete chats (src/lib/inbox/chat-export.ts): the thread
// header's "⋯" menu for one chat, and the confirm dialog shared with the
// conversation list's bulk actions.

import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, MoreVertical, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { useCan } from "@/hooks/use-can";
import {
  chatsCsv,
  deleteChats,
  downloadCsv,
  loadChatMessages,
  loadTeamNames,
  type ExportChat,
} from "@/lib/inbox/chat-export";
import type { Contact, Conversation } from "@/types";

/** Build and download the CSV for these chats. Returns the message count. */
export function useExportChats() {
  const t = useTranslations("Inbox.chatActions");
  return async (chats: ExportChat[], fileStem: string) => {
    const db = createClient();
    const [messages, teamNames] = await Promise.all([
      loadChatMessages(db, chats.map((c) => c.id)),
      loadTeamNames(db),
    ]);
    const csv = chatsCsv(
      chats,
      messages,
      {
        header: [
          t("colContact"),
          t("colPhone"),
          t("colTime"),
          t("colFrom"),
          t("colMessage"),
          t("colDelivery"),
          t("colChatStatus"),
        ],
        contact: t("fromContact"),
        team: t("fromTeam"),
        bot: t("fromBot"),
        elevenLabsBot: t("fromElevenLabs"),
        ai: t("fromAi"),
      },
      teamNames,
    );
    const safeStem = fileStem.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "chats";
    downloadCsv(`${safeStem}-${format(new Date(), "yyyy-MM-dd")}.csv`, csv);
    return messages.length;
  };
}

export function toExportChat(conv: Conversation, contact?: Contact | null): ExportChat {
  const c = contact ?? conv.contact ?? null;
  return { id: conv.id, status: conv.status, contactName: c?.name ?? null, contactPhone: c?.phone ?? null };
}

export function DeleteChatsDialog({
  conversationIds,
  onClose,
  onDeleted,
}: {
  /** Chats to delete; the dialog is open while this is non-empty. */
  conversationIds: string[];
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
}) {
  const t = useTranslations("Inbox.chatActions");
  const [busy, setBusy] = useState(false);
  const count = conversationIds.length;

  async function confirm() {
    setBusy(true);
    try {
      const deleted = await deleteChats(createClient(), conversationIds);
      if (deleted < count) {
        toast.error(t("deletePartial", { deleted, count }));
      } else {
        toast.success(t("deleted", { count: deleted }));
      }
      onDeleted(conversationIds);
    } catch (err) {
      toast.error(t("deleteFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={count > 0} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("deleteTitle", { count })}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t("deleteDesc", { count })}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t("deleteConfirm", { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "⋯" in the thread header: export or delete this chat. */
export function ChatActionsMenu({
  conversation,
  contact,
  onDeleted,
}: {
  conversation: Conversation;
  contact: Contact | null;
  onDeleted: (ids: string[]) => void;
}) {
  const t = useTranslations("Inbox.chatActions");
  const canDelete = useCan("edit-settings");
  const exportChats = useExportChats();
  const [exporting, setExporting] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);

  async function exportThis() {
    setExporting(true);
    try {
      const chat = toExportChat(conversation, contact);
      await exportChats([chat], chat.contactName || chat.contactPhone || "chat");
    } catch (err) {
      toast.error(t("exportFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("menu")}
          title={t("menu")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreVertical className="h-3.5 w-3.5" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-popover">
          <DropdownMenuItem onClick={() => void exportThis()} className="text-sm text-popover-foreground">
            <Download className="mr-2 h-3.5 w-3.5" />
            {t("exportChat")}
          </DropdownMenuItem>
          {canDelete && (
            <DropdownMenuItem
              onClick={() => setDeleteIds([conversation.id])}
              className="text-sm text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {t("deleteChat")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteChatsDialog
        conversationIds={deleteIds}
        onClose={() => setDeleteIds([])}
        onDeleted={(ids) => {
          setDeleteIds([]);
          onDeleted(ids);
        }}
      />
    </>
  );
}
