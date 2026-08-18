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

interface PendingChatAttempt {
  chat: Chat;
  filesKey: string;
  attachmentIds: string[];
  uploadTokens: string[];
}

const EMPTY_MESSAGES: ChatMessage[] = [];
const RECOVERY_POLL_MS = 1_500;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96;

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

function getFilesKey(files: File[]): string {
  return files.map((file) => `${file.name}:${file.size}:${file.lastModified}:${file.type}`).join("|");
}

function autoTitle(content: string): string {
  const cleaned = content.trim().replace(/\s+/g, " ");
  if (!cleaned) return "Новый чат";
  return cleaned.length <= 50 ? cleaned : `${cleaned.slice(0, 47)}…`;
}

function lastMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages[messages.length - 1];
}

export function ChatPageClient({ chatId: chatIdProp, projectId }: ChatPageClientProps) {
  const router = useRouter();
  const params = useParams();
  const routeChatId = chatIdProp ?? (typeof params.chatId === "string" ? params.chatId : undefined);
  const [pendingChatId, setPendingChatId] = useState<string | undefined>();
  const chatId = routeChatId ?? pendingChatId;
  const [chat, setChat] = useState<Chat | null>(null);
  const [messagesByChat, setMessagesByChat] = useState<Record<string, ChatMessage[]>>({});
  const messages = useMemo(
    () => (chatId ? (messagesByChat[chatId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES),
    [chatId, messagesByChat],
  );
  const [sending, setSending] = useState(false);
  const [recoveringTurn, setRecoveringTurn] = useState(false);
  const [liveActivity, setLiveActivity] = useState<AgentUiEvent[]>([]);
  const [sendError, setSendError] = useState<ErrorCardData | null>(null);
  const [loadedChatIds, setLoadedChatIds] = useState<Record<string, boolean>>({});
  const loading = !!chatId && !loadedChatIds[chatId] && messages.length === 0;
  const recentChats = useRecentChatsOptional();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabledRef = useRef(true);
  const forceNextScrollRef = useRef(true);
  const fetchGenerationRef = useRef(0);
  const pendingChatAttemptRef = useRef<PendingChatAttempt | null>(null);
  const displayedChat = chat?.id === chatId ? chat : null;
  const latestMessage = lastMessage(messages);
  const busy = sending || recoveringTurn;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = scrollContainerRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const element = scrollContainerRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    autoScrollEnabledRef.current = distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    autoScrollEnabledRef.current = true;
    forceNextScrollRef.current = true;
  }, [chatId]);

  const applyRemoteChat = useCallback((remoteChat: Chat) => {
    setChat(remoteChat);
    recentChats?.updateChatTitle(remoteChat.id, remoteChat.title);
  }, [recentChats]);

  const fetchChatSnapshot = useCallback(async (
    activeChatId: string,
    signal?: AbortSignal,
  ): Promise<{ chat: Chat | null; messages: ChatMessage[] | null }> => {
    const [chatRes, msgRes] = await Promise.all([
      fetch(`/api/chats/${activeChatId}`, { cache: "no-store", signal }).then((r) => r.json()),
      fetch(`/api/chats/${activeChatId}/messages`, { cache: "no-store", signal }).then((r) => r.json()),
    ]);
    return {
      chat: chatRes.ok ? (chatRes.data as Chat) : null,
      messages: msgRes.ok ? (msgRes.data.messages as ChatMessage[]) : null,
    };
  }, []);

  useEffect(() => {
    if (!chatId) return;
    const requestGeneration = ++fetchGenerationRef.current;
    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await fetchChatSnapshot(chatId, controller.signal);
        if (cancelled) return;
        if (snapshot.chat) applyRemoteChat(snapshot.chat);
        if (snapshot.messages) {
          setMessagesByChat((prev) => ({
            ...prev,
            [chatId]: applyFetchedMessages({
              fetched: snapshot.messages!,
              local: prev[chatId] ?? [],
              requestGeneration,
              latestGeneration: fetchGenerationRef.current,
              chatId,
            }),
          }));
          setRecoveringTurn(lastMessage(snapshot.messages)?.role === "user");
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
  }, [chatId, applyRemoteChat, fetchChatSnapshot]);

  // Recovery path for reloads, route remounts and interrupted SSE streams. A persisted
  // user message without a following assistant message means the server-side turn is
  // still in flight (or its final message has not reached this browser yet).
  useEffect(() => {
    if (!chatId || sending || latestMessage?.role !== "user") return;

    let cancelled = false;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const snapshot = await fetchChatSnapshot(chatId, controller.signal);
        if (cancelled) return;
        if (snapshot.chat) applyRemoteChat(snapshot.chat);
        if (snapshot.messages) {
          setMessagesByChat((prev) => ({ ...prev, [chatId]: snapshot.messages! }));
          setRecoveringTurn(lastMessage(snapshot.messages)?.role === "user");
        }
      } catch {
        if (!controller.signal.aborted) setRecoveringTurn(true);
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), RECOVERY_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [
    chatId,
    sending,
    latestMessage?.id,
    latestMessage?.role,
    applyRemoteChat,
    fetchChatSnapshot,
  ]);

  // Follow only the dedicated message viewport. Never call scrollIntoView here: that can
  // scroll the document/dashboard ancestors and was the cause of the page being pinned in
  // the middle while a durable task emitted live updates.
  useEffect(() => {
    if (!autoScrollEnabledRef.current && !forceNextScrollRef.current) return;
    forceNextScrollRef.current = false;
    scrollToBottom("auto");
  }, [messages, liveActivity, recoveringTurn, scrollToBottom]);

  const createChat = async () => {
    const res = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: projectId ?? null }),
    });
    const data = await res.json();
    if (data.ok) {
      pendingChatAttemptRef.current = null;
      setPendingChatId(data.data.id);
      setChat(data.data);
      recentChats?.prependChat({ id: data.data.id, title: data.data.title });
      setSendError(null);
      router.push(`/chat/${data.data.id}`);
    }
  };

  const uploadAttachments = async (
    activeChatId: string,
    files: File[],
    uploadTokens: string[],
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (const [index, file] of files.entries()) {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/chats/${activeChatId}/attachments`, {
        method: "POST",
        headers: uploadTokens[index] ? { "X-Upload-Token": uploadTokens[index] } : undefined,
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data.data?.attachmentId) {
        throw new Error(data?.error?.message ?? `Не удалось загрузить ${file.name}`);
      }
      ids.push(data.data.attachmentId as string);
    }
    return ids;
  };

  const handleSend = async (
    content: string,
    options: { modelId?: string; reasoningLevel?: string; files: File[] },
  ): Promise<boolean> => {
    if (busy) return false;
    autoScrollEnabledRef.current = true;
    forceNextScrollRef.current = true;
    setSending(true);
    setRecoveringTurn(false);
    setSendError(null);
    setLiveActivity([]);

    const newChatTurn = !chatId;
    const currentFilesKey = getFilesKey(options.files);
    let activeChatId = chatId;
    let provisionalChat: Chat | null = null;
    let optimistic: ChatMessage | null = null;
    let accepted = false;

    const acceptNewChat = () => {
      if (!newChatTurn || !activeChatId || !provisionalChat || accepted) return;
      accepted = true;
      pendingChatAttemptRef.current = null;
      const titledChat = { ...provisionalChat, title: autoTitle(content) };
      provisionalChat = titledChat;
      setPendingChatId(activeChatId);
      setChat(titledChat);
      recentChats?.prependChat({ id: titledChat.id, title: titledChat.title });
      // Do not use Next router here: changing /chat -> /chat/[id] remounts the component
      // and used to destroy the live SSE activity state. Updating browser history keeps
      // reload recovery while the current component continues reading the stream.
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", `/chat/${activeChatId}`);
      }
    };

    const synchronizeRouteAfterTurn = () => {
      if (newChatTurn && activeChatId) router.replace(`/chat/${activeChatId}`);
    };

    try {
      let pendingAttempt = newChatTurn ? pendingChatAttemptRef.current : null;
      if (!activeChatId) {
        if (pendingAttempt) {
          activeChatId = pendingAttempt.chat.id;
          provisionalChat = pendingAttempt.chat;
        } else {
          const res = await fetch("/api/chats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: projectId ?? null, modelId: options.modelId }),
          });
          const data = await res.json();
          if (!data.ok) {
            setSendError({ code: data.error?.code, message: data.error?.message ?? t("common.error") });
            return false;
          }
          provisionalChat = data.data as Chat;
          activeChatId = provisionalChat.id;
          pendingAttempt = {
            chat: provisionalChat,
            filesKey: currentFilesKey,
            attachmentIds: [],
            uploadTokens: options.files.map(() => crypto.randomUUID()),
          };
          pendingChatAttemptRef.current = pendingAttempt;
        }
      }

      if (!activeChatId) return false;

      let attachmentIds: string[] = [];
      if (pendingAttempt && pendingAttempt.filesKey !== currentFilesKey) {
        pendingAttempt.filesKey = currentFilesKey;
        pendingAttempt.attachmentIds = [];
        pendingAttempt.uploadTokens = options.files.map(() => crypto.randomUUID());
      }
      if (pendingAttempt?.attachmentIds.length === options.files.length) {
        attachmentIds = pendingAttempt.attachmentIds;
      } else if (options.files.length) {
        setLiveActivity([{ type: "attachment.upload", label: "● Загружаю и разбираю источник…", status: "running" }]);
        const tokens = pendingAttempt?.uploadTokens.length === options.files.length
          ? pendingAttempt.uploadTokens
          : options.files.map(() => crypto.randomUUID());
        if (pendingAttempt) pendingAttempt.uploadTokens = tokens;
        attachmentIds = await uploadAttachments(activeChatId, options.files, tokens);
        if (pendingAttempt) pendingAttempt.attachmentIds = attachmentIds;
        setLiveActivity([{ type: "attachment.uploaded", label: "✓ Источник готов", status: "completed" }]);
      }

      optimistic = optimisticUserMessage(activeChatId, content);
      setMessagesByChat((prev) => ({
        ...prev,
        [activeChatId!]: mergeMessagesById(prev[activeChatId!] ?? [], [optimistic!]),
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
          return [...prev.filter((item) => `${item.type}-${item.toolName ?? ""}-${item.label ?? ""}` !== key), next];
        });
      };

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
        let messageAccepted = false;
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
              if (event.type === "message.accepted") {
                messageAccepted = true;
                acceptNewChat();
              } else if (event.type === "turn.completed" && event.content) {
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
              optimistic!.id,
              [turnResult!.userMessage, turnResult!.assistantMessage],
            ),
          }));
          acceptNewChat();
          setRecoveringTurn(false);
          synchronizeRouteAfterTurn();
          return true;
        }
        if (messageAccepted) {
          acceptNewChat();
          setRecoveringTurn(true);
          setSendError({ message: "Сообщение сохранено. Соединение с потоком ответа прервалось — продолжаю проверять результат автоматически." });
          return true;
        }
      } else {
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok) {
          const userMessage = data.data.userMessage as ChatMessage;
          const assistantMessage = data.data.assistantMessage as ChatMessage;
          setMessagesByChat((prev) => ({
            ...prev,
            [activeChatId!]: replaceOptimisticUserMessage(
              prev[activeChatId!] ?? [],
              optimistic!.id,
              [userMessage, assistantMessage],
            ),
          }));
          acceptNewChat();
          setRecoveringTurn(false);
          synchronizeRouteAfterTurn();
          return true;
        }
        setSendError({ code: data?.error?.code, message: data?.error?.message ?? t("common.error") });
      }

      if (optimistic) {
        setMessagesByChat((prev) => ({
          ...prev,
          [activeChatId!]: (prev[activeChatId!] ?? []).filter((item) => item.id !== optimistic!.id),
        }));
      }
      setSendError({ message: t("common.error") });
      return false;
    } catch (error) {
      setSendError({ message: error instanceof Error ? error.message : t("common.error") });
      return false;
    } finally {
      setSending(false);
      setLiveActivity([]);
    }
  };

  if (!chatId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-2 pb-[14vh] pt-8 sm:px-4">
          <div className="w-full max-w-4xl">
            <div className="mx-auto mb-6 max-w-3xl px-4">
              <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Над чем поработаем?</h1>
            </div>
            <ChatComposer onSend={handleSend} disabled={busy} variant="hero" autoFocus />
            {sendError ? <div className="mx-auto mt-4 max-w-3xl px-4"><ErrorCard error={sendError} /></div> : null}
            <p className="mt-3 text-center text-xs text-muted-foreground">Enter — отправить · Shift+Enter — новая строка</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
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
          <Button variant="ghost" size="sm" onClick={createChat} disabled={busy}>
            <Plus className="h-4 w-4" />
            {t("chat.newChat")}
          </Button>
        </div>
      </header>

      <div
        ref={scrollContainerRef}
        onScroll={handleMessagesScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {loading && messages.length === 0 ? (
          <div className="space-y-4 p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        ) : messages.length === 0 && !sendError ? (
          <EmptyState title={t("chat.empty")} description={t("chat.emptyDescription")} />
        ) : (
          <div className="mx-auto max-w-3xl divide-y divide-border-subtle">
            {messages.map((msg) => <ChatMessageView key={msg.id} message={msg} />)}
            {sending && liveActivity.length > 0 ? (
              <div className="px-4 py-2"><AgentActivityPanel events={liveActivity} isActive /></div>
            ) : busy ? (
              <div className="px-4 py-2">
                <AgentActivityPanel
                  events={[{
                    type: "agent.run.started",
                    label: recoveringTurn ? "● Агент работает — ожидаю результат…" : "● Думаю…",
                    status: "running",
                  }]}
                  isActive
                />
              </div>
            ) : null}
            {sendError ? <div className="px-4 py-4"><ErrorCard error={sendError} /></div> : null}
          </div>
        )}
      </div>

      <div className="shrink-0">
        <ChatComposer
          key={`${chatId}-${displayedChat?.model_id ?? ""}-${String(displayedChat?.metadata?.reasoning_level ?? "")}`}
          onSend={handleSend}
          disabled={busy}
          chatId={chatId}
          defaultModelId={displayedChat?.model_id ?? undefined}
          defaultReasoningLevel={
            typeof displayedChat?.metadata?.reasoning_level === "string" ? displayedChat.metadata.reasoning_level : undefined
          }
        />
      </div>
    </div>
  );
}
