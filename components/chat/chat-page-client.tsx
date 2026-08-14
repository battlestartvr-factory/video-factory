"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { ChatMessageView } from "@/components/chat/chat-message";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ErrorCard } from "@/components/chat/error-card";
import { t } from "@/lib/i18n/dictionary";
import {
  applyFetchedMessages,
  mergeMessagesById,
  replaceOptimisticUserMessage,
} from "@/lib/chat/messages-state";
import type { Chat, ChatMessage, ErrorCardData, Preset } from "@/lib/types/workspace";

interface ChatPageClientProps {
  chatId?: string;
  projectId?: string;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

function optimisticUserMessage(chatId: string, content: string): ChatMessage {
  return {
    id: `optimistic-${crypto.randomUUID()}`,
    chat_id: chatId,
    role: "user",
    content,
    metadata: {},
    created_at: new Date().toISOString(),
  };
}

export function ChatPageClient({ chatId: chatIdProp, projectId }: ChatPageClientProps) {
  const router = useRouter();
  const params = useParams();
  const routeChatId =
    chatIdProp ??
    (typeof params.chatId === "string" ? params.chatId : undefined);
  const [pendingChatId, setPendingChatId] = useState<string | undefined>();
  const chatId = routeChatId ?? pendingChatId;
  const [chat, setChat] = useState<Chat | null>(null);
  const [messagesByChat, setMessagesByChat] = useState<Record<string, ChatMessage[]>>({});
  const messages = useMemo(
    () => (chatId ? (messagesByChat[chatId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES),
    [chatId, messagesByChat],
  );
  const [presets, setPresets] = useState<Preset[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ErrorCardData | null>(null);
  const [loadedChatIds, setLoadedChatIds] = useState<Record<string, boolean>>({});
  const loading = !!chatId && !loadedChatIds[chatId] && messages.length === 0;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fetchGenerationRef = useRef(0);
  const displayedChat = chat?.id === chatId ? chat : null;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    fetch("/api/presets?type=chat")
      .then((r) => r.json())
      .then((d) => { if (d.ok) setPresets(d.data.presets); });
  }, []);

  useEffect(() => {
    if (!chatId) return;
    const requestGeneration = ++fetchGenerationRef.current;
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const [chatRes, msgRes] = await Promise.all([
          fetch(`/api/chats/${chatId}`, { cache: "no-store", signal: controller.signal }).then((r) => r.json()),
          fetch(`/api/chats/${chatId}/messages`, { cache: "no-store", signal: controller.signal }).then((r) => r.json()),
        ]);
        if (cancelled) return;
        if (chatRes.ok) setChat(chatRes.data);
        if (msgRes.ok) {
          setMessagesByChat((prev) => ({
            ...prev,
            [chatId]: applyFetchedMessages({
              fetched: msgRes.data.messages as ChatMessage[],
              local: prev[chatId] ?? [],
              requestGeneration,
              latestGeneration: fetchGenerationRef.current,
              chatId,
            }),
          }));
        }
      } catch {
        if (controller.signal.aborted) return;
      } finally {
        if (!cancelled && requestGeneration === fetchGenerationRef.current) {
          setLoadedChatIds((prev) => ({ ...prev, [chatId]: true }));
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [chatId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const createChat = async () => {
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: projectId ?? null }),
    });
    const data = await res.json();
    if (data.ok) {
      setPendingChatId(data.data.id);
      setChat(data.data);
      setSendError(null);
      router.push(`/chat/${data.data.id}`);
    }
  };

  const handleSend = async (content: string, options: { modelId?: string; presetId?: string; files: File[] }) => {
    if (sending) return;
    setSendError(null);

    let activeChatId = chatId;
    if (!activeChatId) {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: projectId ?? null, modelId: options.modelId, presetId: options.presetId }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSendError({
          code: data.error?.code,
          message: data.error?.message ?? t("common.error"),
        });
        return;
      }
      activeChatId = data.data.id as string;
      setPendingChatId(activeChatId);
      setChat(data.data);
    }

    if (!activeChatId) return;

    const optimistic = optimisticUserMessage(activeChatId, content);
    setMessagesByChat((prev) => ({
      ...prev,
      [activeChatId]: mergeMessagesById(prev[activeChatId] ?? [], [optimistic]),
    }));
    setSending(true);

    try {
      const res = await fetch(`/api/chats/${activeChatId}/messages`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, modelId: options.modelId, presetId: options.presetId }),
      });
      const data = await res.json();
      if (data.ok) {
        const userMessage = data.data.userMessage as ChatMessage;
        const assistantMessage = data.data.assistantMessage as ChatMessage;
        setMessagesByChat((prev) => ({
          ...prev,
          [activeChatId]: replaceOptimisticUserMessage(
            prev[activeChatId] ?? [],
            optimistic.id,
            [userMessage, assistantMessage],
          ),
        }));
      } else {
        setSendError({
          code: data.error?.code,
          message: data.error?.message ?? t("common.error"),
        });
      }
    } catch {
      setSendError({ message: t("common.error") });
    } finally {
      setSending(false);
      if (!chatId && activeChatId) {
        router.push(`/chat/${activeChatId}`);
      }
    }
  };

  if (!chatId) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-muted">
            <MessageSquare className="h-8 w-8 text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">{t("chat.empty")}</h1>
          <p className="mt-2 max-w-md text-center text-sm text-muted-foreground">
            {t("chat.emptyDescription")}
          </p>
          <Button className="mt-6" onClick={createChat}>
            <Plus className="h-4 w-4" />
            {t("chat.newChat")}
          </Button>
        </div>
        <ChatComposer onSend={handleSend} disabled={sending} presets={presets} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="truncate text-sm font-medium text-foreground">
          {displayedChat?.title ?? t("chat.title")}
        </h1>
        <Button variant="ghost" size="sm" onClick={createChat}>
          <Plus className="h-4 w-4" />
          {t("chat.newChat")}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading && messages.length === 0 ? (
          <div className="space-y-4 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : messages.length === 0 && !sendError ? (
          <EmptyState title={t("chat.empty")} description={t("chat.emptyDescription")} />
        ) : (
          <div className="mx-auto max-w-3xl divide-y divide-border-subtle">
            {messages.map((msg) => (
              <ChatMessageView key={msg.id} message={msg} />
            ))}
            {sendError ? (
              <div className="px-4 py-4">
                <ErrorCard error={sendError} />
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <ChatComposer
        onSend={handleSend}
        disabled={sending}
        presets={presets}
        defaultModelId={displayedChat?.model_id ?? undefined}
        defaultPresetId={displayedChat?.preset_id ?? undefined}
      />
    </div>
  );
}
