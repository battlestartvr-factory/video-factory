"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { ChatMessageView } from "@/components/chat/chat-message";
import { ChatComposer } from "@/components/chat/chat-composer";
import { t } from "@/lib/i18n/dictionary";
import type { Chat, ChatMessage, Preset } from "@/lib/types/workspace";

interface ChatPageClientProps {
  chatId?: string;
  projectId?: string;
}

export function ChatPageClient({ chatId: initialChatId, projectId }: ChatPageClientProps) {
  const router = useRouter();
  const [chatId, setChatId] = useState(initialChatId);
  const [chat, setChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(!!initialChatId);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    let cancelled = false;
    void (async () => {
      const [chatRes, msgRes] = await Promise.all([
        fetch(`/api/chats/${chatId}`).then((r) => r.json()),
        fetch(`/api/chats/${chatId}/messages`).then((r) => r.json()),
      ]);
      if (cancelled) return;
      if (chatRes.ok) setChat(chatRes.data);
      if (msgRes.ok) setMessages(msgRes.data.messages);
      setLoading(false);
    })();
    return () => { cancelled = true; };
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
      setChatId(data.data.id);
      router.push(`/chat/${data.data.id}`);
    }
  };

  const handleSend = async (content: string, options: { modelId?: string; presetId?: string; files: File[] }) => {
    let activeChatId = chatId;
    if (!activeChatId) {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: projectId ?? null, modelId: options.modelId, presetId: options.presetId }),
      });
      const data = await res.json();
      if (!data.ok) return;
      activeChatId = data.data.id;
      setChatId(activeChatId);
      setChat(data.data);
      router.push(`/chat/${activeChatId}`);
    }

    setSending(true);
    const res = await fetch(`/api/chats/${activeChatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, modelId: options.modelId, presetId: options.presetId }),
    });
    const data = await res.json();
    if (data.ok) {
      setMessages((prev) => [...prev, data.data.userMessage, data.data.assistantMessage]);
    }
    setSending(false);
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
          {chat?.title ?? t("chat.title")}
        </h1>
        <Button variant="ghost" size="sm" onClick={createChat}>
          <Plus className="h-4 w-4" />
          {t("chat.newChat")}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-4 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : messages.length === 0 ? (
          <EmptyState title={t("chat.empty")} description={t("chat.emptyDescription")} />
        ) : (
          <div className="mx-auto max-w-3xl divide-y divide-border-subtle">
            {messages.map((msg) => (
              <ChatMessageView key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <ChatComposer
        onSend={handleSend}
        disabled={sending}
        presets={presets}
        defaultModelId={chat?.model_id ?? undefined}
        defaultPresetId={chat?.preset_id ?? undefined}
      />
    </div>
  );
}
