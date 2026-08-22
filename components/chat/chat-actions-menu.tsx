"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n/dictionary";
import { useRecentChatsOptional } from "@/components/providers/recent-chats-provider";

interface ChatActionsMenuProps {
  chatId: string;
  title: string;
  onRenamed?: (title: string) => void;
  onDeleted?: () => void;
  variant?: "header" | "sidebar";
}

export function ChatActionsMenu({
  chatId,
  title,
  onRenamed,
  onDeleted,
  variant = "header",
}: ChatActionsMenuProps) {
  const router = useRouter();
  const pathname = usePathname();
  const recentChats = useRecentChatsOptional();
  const [open, setOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (!deleteConfirmOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        setDeleteConfirmOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [deleteConfirmOpen, deleting]);

  const handleRename = async () => {
    setOpen(false);
    const next = window.prompt("Название чата", title);
    if (!next?.trim() || next.trim() === title) return;
    const res = await fetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next.trim() }),
    });
    const data = await res.json();
    if (data.ok) {
      recentChats?.updateChatTitle(chatId, data.data.title);
      onRenamed?.(data.data.title);
    }
  };

  const requestDelete = () => {
    setOpen(false);
    setDeleteConfirmOpen(true);
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);

    const removed = recentChats?.removeChat(chatId) ?? null;
    const isCurrentChat = pathname === `/chat/${chatId}`;

    if (isCurrentChat) {
      router.replace("/chat");
    }
    onDeleted?.();

    try {
      const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
      const data = await res.json();

      if (data.ok) {
        setDeleteConfirmOpen(false);
        setToast(t("chat.deleted"));
        setTimeout(() => setToast(null), 3000);
        return;
      }

      if (removed && recentChats) {
        recentChats.restoreChat(removed);
      }
      if (isCurrentChat) {
        router.replace(`/chat/${chatId}`);
      }
      setToast("Не удалось удалить чат");
      setTimeout(() => setToast(null), 3000);
    } catch {
      if (removed && recentChats) {
        recentChats.restoreChat(removed);
      }
      if (isCurrentChat) {
        router.replace(`/chat/${chatId}`);
      }
      setToast("Не удалось удалить чат");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setDeleting(false);
    }
  };

  const deleteDialog = deleteConfirmOpen && typeof document !== "undefined"
    ? createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) {
              setDeleteConfirmOpen(false);
            }
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`delete-chat-title-${chatId}`}
            aria-describedby={`delete-chat-description-${chatId}`}
            className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <h2 id={`delete-chat-title-${chatId}`} className="text-base font-semibold text-foreground">
              {t("chat.delete")}
            </h2>
            <p id={`delete-chat-description-${chatId}`} className="mt-2 text-sm leading-6 text-muted-foreground">
              {t("chat.deleteConfirm")}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                type="button"
                disabled={deleting}
                onClick={() => setDeleteConfirmOpen(false)}
              >
                Отмена
              </Button>
              <Button
                variant="destructive"
                type="button"
                disabled={deleting}
                onClick={() => void handleDelete()}
              >
                {deleting ? "Удаляем…" : t("chat.delete")}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <div className="relative" ref={menuRef}>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className={variant === "sidebar" ? "h-6 w-6 p-0 opacity-0 group-hover:opacity-100" : undefined}
          onClick={() => setOpen((v) => !v)}
          aria-label="Действия с чатом"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>

        {open ? (
          <div className="absolute right-0 z-50 mt-1 min-w-[10rem] rounded-lg border border-border bg-surface py-1 shadow-lg">
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-hover"
              onClick={handleRename}
            >
              {t("chat.rename")}
            </button>
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-destructive hover:bg-surface-hover"
              onClick={requestDelete}
            >
              {t("chat.delete")}
            </button>
          </div>
        ) : null}
      </div>

      {deleteDialog}

      {toast ? (
        <div className="fixed bottom-20 left-1/2 z-[110] -translate-x-1/2 rounded-lg bg-foreground px-4 py-2 text-sm text-background shadow-lg md:bottom-8">
          {toast}
        </div>
      ) : null}
    </>
  );
}
