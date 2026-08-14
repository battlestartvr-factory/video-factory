import type { ChatMessage } from "@/lib/types/workspace";

export function mergeMessagesById(...lists: ChatMessage[][]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const list of lists) {
    for (const message of list) {
      if (!message?.id) continue;
      byId.set(message.id, message);
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    if (a.role !== b.role) {
      const rank = (role: ChatMessage["role"]) =>
        role === "user" ? 0 : role === "assistant" ? 1 : 2;
      return rank(a.role) - rank(b.role);
    }
    return a.id < b.id ? -1 : 1;
  });
}

export function isStaleMessagesFetch(
  requestGeneration: number,
  latestGeneration: number,
): boolean {
  return requestGeneration !== latestGeneration;
}

export function applyFetchedMessages(args: {
  fetched: ChatMessage[];
  local: ChatMessage[];
  requestGeneration: number;
  latestGeneration: number;
  chatId?: string;
}): ChatMessage[] {
  const local = args.chatId
    ? args.local.filter((message) => message.chat_id === args.chatId)
    : args.local;

  if (isStaleMessagesFetch(args.requestGeneration, args.latestGeneration)) {
    return local;
  }

  const localWithoutResolvedOptimistic = local.filter((message) => {
    if (!message.id.startsWith("optimistic-")) return true;
    return !args.fetched.some(
      (item) =>
        item.role === "user" &&
        item.chat_id === message.chat_id &&
        item.content === message.content,
    );
  });

  return mergeMessagesById(args.fetched, localWithoutResolvedOptimistic);
}

export function replaceOptimisticUserMessage(
  local: ChatMessage[],
  optimisticId: string,
  incoming: ChatMessage[],
): ChatMessage[] {
  return mergeMessagesById(
    local.filter((message) => message.id !== optimisticId),
    incoming,
  );
}
