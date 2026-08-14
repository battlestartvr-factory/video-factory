"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RecentChat } from "@/lib/chat/recent-chats-state";
import {
  prependChatToList,
  removeChatFromList,
  updateChatTitleInList,
} from "@/lib/chat/recent-chats-state";

interface RecentChatsContextValue {
  recentChats: RecentChat[];
  removeChat: (chatId: string) => RecentChat | null;
  restoreChat: (chat: RecentChat) => void;
  updateChatTitle: (chatId: string, title: string) => void;
  prependChat: (chat: RecentChat) => void;
}

const RecentChatsContext = createContext<RecentChatsContextValue | null>(null);

export function RecentChatsProvider({
  initialChats,
  children,
}: {
  initialChats: RecentChat[];
  children: ReactNode;
}) {
  const [recentChats, setRecentChats] = useState(initialChats);

  const removeChat = useCallback((chatId: string): RecentChat | null => {
    let removed: RecentChat | null = null;
    setRecentChats((prev) => {
      removed = prev.find((chat) => chat.id === chatId) ?? null;
      return removeChatFromList(prev, chatId);
    });
    return removed;
  }, []);

  const restoreChat = useCallback((chat: RecentChat) => {
    setRecentChats((prev) => prependChatToList(prev, chat));
  }, []);

  const updateChatTitle = useCallback((chatId: string, title: string) => {
    setRecentChats((prev) => updateChatTitleInList(prev, chatId, title));
  }, []);

  const prependChat = useCallback((chat: RecentChat) => {
    setRecentChats((prev) => prependChatToList(prev, chat));
  }, []);

  const value = useMemo(
    () => ({
      recentChats,
      removeChat,
      restoreChat,
      updateChatTitle,
      prependChat,
    }),
    [recentChats, removeChat, restoreChat, updateChatTitle, prependChat],
  );

  return <RecentChatsContext.Provider value={value}>{children}</RecentChatsContext.Provider>;
}

export function useRecentChats(): RecentChatsContextValue {
  const ctx = useContext(RecentChatsContext);
  if (!ctx) {
    throw new Error("useRecentChats must be used within RecentChatsProvider");
  }
  return ctx;
}

export function useRecentChatsOptional(): RecentChatsContextValue | null {
  return useContext(RecentChatsContext);
}
