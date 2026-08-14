import { describe, expect, it } from "vitest";
import {
  prependChatToList,
  removeChatFromList,
  updateChatTitleInList,
  type RecentChat,
} from "@/lib/chat/recent-chats-state";

const chats: RecentChat[] = [
  { id: "a", title: "Chat A" },
  { id: "b", title: "Chat B" },
  { id: "c", title: "Chat C" },
];

describe("recent chats state", () => {
  it("removeChatFromList removes the chat immediately", () => {
    const next = removeChatFromList(chats, "b");
    expect(next).toHaveLength(2);
    expect(next.find((chat) => chat.id === "b")).toBeUndefined();
    expect(next.map((chat) => chat.id)).toEqual(["a", "c"]);
  });

  it("updateChatTitleInList updates title in place", () => {
    const next = updateChatTitleInList(chats, "b", "Renamed B");
    expect(next.find((chat) => chat.id === "b")?.title).toBe("Renamed B");
    expect(chats.find((chat) => chat.id === "b")?.title).toBe("Chat B");
  });

  it("prependChatToList adds chat at front and caps at 5", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `id-${i}`,
      title: `Chat ${i}`,
    }));
    const next = prependChatToList(many, { id: "new", title: "New Chat" });
    expect(next[0]).toEqual({ id: "new", title: "New Chat" });
    expect(next).toHaveLength(5);
  });

  it("failed delete rollback restores previous list via prepend", () => {
    const removed = chats.find((chat) => chat.id === "b")!;
    const afterDelete = removeChatFromList(chats, "b");
    const rolledBack = prependChatToList(afterDelete, removed);
    expect(rolledBack.map((chat) => chat.id)).toEqual(["b", "a", "c"]);
  });
});
