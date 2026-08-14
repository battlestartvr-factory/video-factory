import type { AgentTool } from "@/lib/agent/types";
import { saveMemorySchema, searchMemorySchema, updateMemorySchema } from "@/lib/agent/schemas";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import { saveMemory, searchMemory, updateMemory } from "@/lib/memory";

export const searchMemoryTool: AgentTool<typeof searchMemorySchema._output> = {
  name: "search_memory",
  description:
    "Search saved memory items. Global memory is always available; project memory is available in a project chat. Use when you need extra remembered facts beyond the context preamble.",
  inputSchema: searchMemorySchema,
  risk: "safe",
  async handler(input, ctx) {
    const items = await searchMemory({
      userId: ctx.userId,
      query: input.query,
      scope: input.scope,
      projectId: ctx.projectId,
    });
    return {
      ok: true,
      data: {
        items: items.map((item) => ({
          id: item.id,
          scope: item.scope,
          content: item.content,
          category: item.category,
          importance: item.importance,
        })),
      },
    };
  },
};

export const saveMemoryTool: AgentTool<typeof saveMemorySchema._output> = {
  name: "save_memory",
  description:
    "Save a permanent memory item. Call ONLY when the user explicitly asks to remember something (запомни / сохрани в память). Do not auto-save ordinary chat.",
  inputSchema: saveMemorySchema,
  risk: "safe",
  async handler(input, ctx) {
    const item = await saveMemory({
      userId: ctx.userId,
      content: input.content,
      scope: input.scope ?? (ctx.projectId ? "project" : "global"),
      projectId: input.scope === "global" ? null : ctx.projectId,
      category: input.category,
      importance: input.importance,
      source: "agent",
    });
    return {
      ok: true,
      data: { memory_id: item.id, scope: item.scope },
    };
  },
};

export const updateMemoryTool: AgentTool<typeof updateMemorySchema._output> = {
  name: "update_memory",
  description: "Update an existing memory item owned by the user. Do not delete memory.",
  inputSchema: updateMemorySchema,
  risk: "safe",
  async handler(input, ctx) {
    try {
      const item = await updateMemory({
        userId: ctx.userId,
        memoryId: input.memory_id,
        content: input.content,
        category: input.category,
        importance: input.importance,
        pinned: input.pinned,
        enabled: input.enabled,
      });
      return { ok: true, data: { memory_id: item.id } };
    } catch (error) {
      if (error instanceof Error && error.name === "NotFoundError") {
        return { ok: false, code: AGENT_ERROR_CODES.NOT_FOUND, error: "Запись памяти не найдена" };
      }
      return { ok: false, code: AGENT_ERROR_CODES.INTERNAL_ERROR, error: "Не удалось обновить память" };
    }
  },
};
