"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { Plus } from "lucide-react";
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
import type { Chat, ChatMessage, ErrorCardData, AgentUiEvent } from "@/lib/types/workspace";
import { AgentActivityPanel } from "@/components/chat/agent-activity-panel";
import { ChatActionsMenu } from "@/components/chat/chat-actions-menu";
import { useRecentChatsOptional } from "@/components/providers/recent-chats-provider";
import type { StreamEvent } from "@/lib/agent/stream-events.types";

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
  const [sending, setSending] = useState(false);
  const [liveActivity, setLiveActivity] = useState<AgentUiEvent[]>([]);
  const [sendError, setSendError] = useState<ErrorCardData | null>(null);
  const [loadedChatIds, setLoadedChatIds] = useState<Record<string, boolean>>({});
  const loading = !!chatId && !loadedChatIds[chatId] && messages.length === 0;
  const recentChats = useRecentChatsOptional();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fetchGenerationRef = useRef(0);
  const displayedChat = chat?.id === chatId ? chat : null;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
      recentChats?.prependChat({ id: data.data.id, title: data.data.title });
      setSendError(null);
      router.push(`/chat/${data.data.id}`);
    }
  };

  const uploadAttachments = async (activeChatId: string, files: File[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/chats/${activeChatId}/attachments`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!data.ok || !data.data?.attachmentId) {
        throw new Error(data.error?.message ?? `Не удалось загрузить ${file.name}`);
      }
      ids.push(data.data.attachmentId as string);
    }
    return ids;
  };

  const handleSend = async (
    content: string,
    options: { modelId?: string; reasoningLevel?: string; files: File[] },
  ) => {
    if (sending) return;
    setSendError(null);
    setLiveActivity([]);

    let activeChatId = chatId;
    if (!activeChatId) {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: projectId ?? null, modelId: options.modelId }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSendError({ code: data.error?.code, message: data.error?.message ?? t("common.error") });
        return;
      }
      activeChatId = data.data.id as string;
      setPendingChatId(activeChatId);
      setChat(data.data);
      recentChats?.prependChat({ id: data.data.id, title: data.data.title });
    }

    if (!activeChatId) return;
    setSending(true);

    let attachmentIds: string[] = [];
    try {
      if (options.files.length) {
        setLiveActivity([{ type: "attachment.upload", label: "● Загружаю и разбираю источник…", status: "running" }]);
        attachmentIds = await uploadAttachments(activeChatId, options.files);
        setLiveActivity([{ type: "attachment.uploaded", label: "✓ Источник готов", status: "completed" }]);
      }
    } catch (error) {
      setSendError({ message: error instanceof Error ? error.message : "Не удалось загрузить документ" });
      setSending(false);
      setLiveActivity([]);
      return;
    }

    const optimistic = optimisticUserMessage(activeChatId, content);
    setMessagesByChat((prev) => ({
      ...prev,
      [activeChatId!]: mergeMessagesById(prev[activeChatId!] ?? [], [optimistic]),
    }));

    const appendActivity = (event: StreamEvent) => {
      if (!event.label && event.type !== "agent.run.started") return;
      setLiveActivity((prev) => {
        const next: AgentUiEvent = {
          type: event.type,
          toolName: event.toolName,
          label: event.label ?? (event.type === "agent.run.started" ? "● Думаю…" : undefined),
          status: event.type.includes("failed")
            ? "failed"
            : event.type.includes("completed") || event.summary?.startsWith("✓")
              ? "completed"
              : "running",
        };
        const key = `${next.type}-${next.toolName ?? ""}-${next.label ?? ""}`;
        const filtered = prev.filter(
          (item) => `${item.type}-${item.toolName ?? ""}-${item.label ?? ""}` !== key,
        );
        return [...filtered, next];
      });
    };

    try {
      const res = await fetch(`/api/chats/${activeChatId}/messages?stream=1`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          modelId: options.modelId,
          reasoningLevel: options.reasoningLevel,
          attachmentIds,
        }),
      });

      if (res.headers.get("content-type")?.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let turnResult: { userMessage: ChatMessage; assistantMessage: ChatMessage } | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const event = JSON.parse(payload) as StreamEvent;
              if (event.type === "turn.completed" && event.content) {
                turnResult = JSON.parse(event.content) as { userMessage: ChatMessage; assistantMessage: ChatMessage };
              } else {
                appendActivity(event);
              }
            } catch {
              // ignore malformed SSE chunks
            }
          }
        }

        if (turnResult) {
          setMessagesByChat((prev) => ({
            ...prev,
            [activeChatId!]: replaceOptimisticUserMessage(
              prev[activeChatId!] ?? [],
              optimistic.id,
              [turnResult!.userMessage, turnResult!.assistantMessage],
            ),
          }));
        } else {
          setSendError({ message: t("common.error") });
        }
      } else {
        const data = await res.json();
        if (data.ok) {
          const userMessage = data.data.userMessage as ChatMessage;
          const assistantMessage = data.data.assistantMessage as ChatMessage;
          setMessagesByChat((prev) => ({
            ...prev,
            [activeChatId!]: replaceOptimisticUserMessage(
              prev[activeChatId!] ?? [],
              optimistic.id,
              [userMessage, assistantMessage],
            ),
          }));
        } else {
          setSendError({ code: data.error?.code, message: data.error?.message ?? t("common.error") });
        }
      }
    } catch {
      setSendError({ message: t("common.error") });
    } finally {
      setSending(false);
      setLiveActivity([]);
      if (!chatId && activeChatId) router.push(`/chat/${activeChatId}`);
    }
  };

  if (!chatId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center px-2 pb-[14vh] pt-8 sm:px-4">
          <div className="w-full max-w-4xl">
            <div className="mx-auto mb-6 max-w-3xl px-4">
              <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Над чем поработаем?
              </h1>
            </div>
            <ChatComposer onSend={handleSend} disabled={sending} variant="hero" autoFocus />
            {sendError ? <div className="mx-auto mt-4 max-w-3xl px-4"><ErrorCard error={sendError} /></div> : null}
            <p className="mt-3 text-center text-xs text-muted-foreground">Enter — отправить · Shift+Enter — новая строка</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="truncate text-sm font-medium text-foreground">{displayedChat?.title ?? t("chat.title")}</h1>
        <div className="flex items-center gap-1">
          {chatId && displayedChat ? (
            <ChatActionsMenu
              chatId={chatId}
              title={displayedChat.title}
              onRenamed={(title) => {
                setChat((c) => (c ? { ...c, title } : c));
                recentChats?.updateChatTitle(chatId, title);
              }}
            />
          ) : null}
          <Button variant="ghost" size="sm" onClick={createChat}>
            <Plus className="h-4 w-4" />
            {t("chat.newChat")}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading && messages.length === 0 ? (
          <div className="space-y-4 p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        ) : messages.length === 0 && !sendError ? (
          <EmptyState title={t("chat.empty")} description={t("chat.emptyDescription")} />
        ) : (
          <div className="mx-auto max-w-3xl divide-y divide-border-subtle">
            {messages.map((msg) => <ChatMessageView key={msg.id} message={msg} />)}
            {sending && liveActivity.length > 0 ? (
              <div className="px-4 py-2"><AgentActivityPanel events={liveActivity} isActive /></div>
            ) : sending ? (
              <div className="px-4 py-2"><AgentActivityPanel events={[{ type: "agent.run.started", label: "● Думаю…" }]} isActive /></div>
            ) : null}
            {sendError ? <div className="px-4 py-4"><ErrorCard error={sendError} /></div> : null}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <ChatComposer
        key={`${chatId}-${displayedChat?.model_id ?? ""}-${String(displayedChat?.metadata?.reasoning_level ?? "")}`}
        onSend={handleSend}
        disabled={sending}
        chatId={chatId}
        defaultModelId={displayedChat?.model_id ?? undefined}
        defaultReasoningLevel={
          typeof displayedChat?.metadata?.reasoning_level === "string" ? displayedChat.metadata.reasoning_level : undefined
        }
      />
    </div>
  );
}
