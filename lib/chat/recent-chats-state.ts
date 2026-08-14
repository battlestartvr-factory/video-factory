import type { Chat } from "@/lib/types/workspace";

export type RecentChat = Pick<Chat, "id" | "title">;

const MAX_RECENT_CHATS = 5;

export function removeChatFromList(chats: RecentChat[], chatId: string): RecentChat[] {
  return chats.filter((chat) => chat.id !== chatId);
}

export function updateChatTitleInList(
  chats: RecentChat[],
  chatId: string,
  title: string,
): RecentChat[] {
  return chats.map((chat) => (chat.id === chatId ? { ...chat, title } : chat));
}

export function prependChatToList(chats: RecentChat[], chat: RecentChat): RecentChat[] {
  const without = removeChatFromList(chats, chat.id);
  return [chat, ...without].slice(0, MAX_RECENT_CHATS);
}

export function upsertChatInList(chats: RecentChat[], chat: RecentChat): RecentChat[] {
  return prependChatToList(chats, chat);
}
