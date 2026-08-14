import { describe, expect, it } from "vitest";
import {
  applyFetchedMessages,
  isStaleMessagesFetch,
  mergeMessagesById,
  replaceOptimisticUserMessage,
} from "@/lib/chat/messages-state";
import type { ChatMessage } from "@/lib/types/workspace";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    chat_id: "chat-1",
    content: partial.content ?? partial.id,
    metadata: {},
    created_at: partial.created_at ?? "2026-08-14T10:00:00.000Z",
    ...partial,
  };
}

describe("mergeMessagesById", () => {
  it("deduplicates by id and keeps chronological order", () => {
    const user = msg({ id: "u1", role: "user", created_at: "2026-08-14T10:00:00.000Z" });
    const assistant = msg({
      id: "a1",
      role: "assistant",
      created_at: "2026-08-14T10:00:01.000Z",
      metadata: { type: "generation" },
    });

    const merged = mergeMessagesById(
      [user, assistant],
      [user, assistant],
    );

    expect(merged.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("lets a later list win for the same id", () => {
    const stale = msg({ id: "a1", role: "assistant", content: "old" });
    const fresh = msg({ id: "a1", role: "assistant", content: "new", metadata: { sources: [{ title: "doc" }] } });

    expect(mergeMessagesById([stale], [fresh]).at(-1)?.content).toBe("new");
    expect(mergeMessagesById([stale], [fresh]).at(-1)?.metadata.sources).toEqual([{ title: "doc" }]);
  });

  it("keeps local-only messages that a stale fetch omitted", () => {
    const history = msg({ id: "h1", role: "user", created_at: "2026-08-14T09:00:00.000Z" });
    const postedUser = msg({ id: "u2", role: "user", created_at: "2026-08-14T10:00:00.000Z" });
    const postedAssistant = msg({ id: "a2", role: "assistant", created_at: "2026-08-14T10:00:02.000Z" });

    const merged = mergeMessagesById([history], [postedUser, postedAssistant]);
    expect(merged.map((m) => m.id)).toEqual(["h1", "u2", "a2"]);
  });
});

describe("applyFetchedMessages", () => {
  it("ignores a stale GET so it cannot wipe a newer POST result", () => {
    const local = [
      msg({ id: "u1", role: "user" }),
      msg({ id: "a1", role: "assistant", content: "done" }),
    ];

    const applied = applyFetchedMessages({
      fetched: [],
      local,
      requestGeneration: 1,
      latestGeneration: 2,
    });

    expect(isStaleMessagesFetch(1, 2)).toBe(true);
    expect(applied.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("empty in-flight GET does not wipe a newer POST result", () => {
    const postedUser = msg({ id: "u2", role: "user" });
    const postedAssistant = msg({ id: "a2", role: "assistant", content: "done" });

    const applied = applyFetchedMessages({
      fetched: [],
      local: [postedUser, postedAssistant],
      requestGeneration: 1,
      latestGeneration: 1,
    });

    expect(applied.map((m) => m.id)).toEqual(["u2", "a2"]);
  });

  it("drops an optimistic user row when the fetch already contains that message", () => {
    const optimistic = msg({
      id: "optimistic-1",
      role: "user",
      content: "hello",
      created_at: "2026-08-14T10:00:00.000Z",
    });
    const user = msg({
      id: "u1",
      role: "user",
      content: "hello",
      created_at: "2026-08-14T10:00:00.100Z",
    });

    const applied = applyFetchedMessages({
      fetched: [user],
      local: [optimistic],
      requestGeneration: 1,
      latestGeneration: 1,
    });

    expect(applied.map((m) => m.id)).toEqual(["u1"]);
  });

  it("merges a fresh GET with local POST messages instead of replacing", () => {
    const history = msg({ id: "h1", role: "user", created_at: "2026-08-14T09:00:00.000Z" });
    const postedUser = msg({ id: "u2", role: "user", created_at: "2026-08-14T10:00:00.000Z" });
    const postedAssistant = msg({ id: "a2", role: "assistant", created_at: "2026-08-14T10:00:02.000Z" });

    const applied = applyFetchedMessages({
      fetched: [history],
      local: [postedUser, postedAssistant],
      requestGeneration: 1,
      latestGeneration: 1,
    });

    expect(applied.map((m) => m.id)).toEqual(["h1", "u2", "a2"]);
  });

  it("drops local messages from another chat when applying a fetch", () => {
    const other = msg({ id: "x1", role: "user", chat_id: "chat-2" });
    const fetched = msg({ id: "n1", role: "assistant", chat_id: "chat-1" });

    const applied = applyFetchedMessages({
      fetched: [fetched],
      local: [other],
      requestGeneration: 3,
      latestGeneration: 3,
      chatId: "chat-1",
    });

    expect(applied.map((m) => m.id)).toEqual(["n1"]);
  });
});

describe("replaceOptimisticUserMessage", () => {
  it("swaps the temp user row for server user+assistant without duplicates", () => {
    const optimistic = msg({ id: "optimistic-1", role: "user", content: "hello" });
    const user = msg({ id: "u1", role: "user", content: "hello" });
    const assistant = msg({ id: "a1", role: "assistant", content: "hi" });

    const next = replaceOptimisticUserMessage([optimistic], optimistic.id, [user, assistant]);
    expect(next.map((m) => `${m.role}:${m.id}`)).toEqual(["user:u1", "assistant:a1"]);
  });
});
