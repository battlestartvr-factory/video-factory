import type { AgentTool } from "@/lib/agent/types";
import { saveMemorySchema, searchMemorySchema, updateMemorySchema } from "@/lib/agent/schemas";
import { AGENT_ERROR_CODES } from "@/lib/agent/config";
import { saveMemory, searchMemory, updateMemory } from "@/lib/memory";

export const searchMemoryTool: AgentTool<typeof searchMemorySchema._output> = {
  name: "search_memory",
  description:
    "Search durable evidence-backed learnings. Global memory is always available; project memory is available in a project chat. Use for reusable learned patterns, not as a substitute for current web/source verification.",
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
          source: item.source,
          importance: item.importance,
          confidence: item.confidence,
          learned_from: item.learned_from,
          evidence: item.evidence,
        })),
      },
    };
  },
};

export const saveMemoryTool: AgentTool<typeof saveMemorySchema._output> = {
  name: "save_memory",
  description:
    "Save ONE atomic durable learning. Use only when the user explicitly asks to remember/learn/import information, or from a dedicated Learning/Intelligence pipeline. For document/market imports, inspect/extract first and save distilled reusable conclusions rather than raw source text. Include source, learned_from, confidence and evidence whenever available.",
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
      source: input.source ?? "agent",
      confidence: input.confidence,
      evidence: input.evidence,
      learnedFrom: input.learned_from,
      sourceRunId: ctx.agentRunId ?? null,
    });
    return {
      ok: true,
      data: {
        memory_id: item.id,
        scope: item.scope,
        confidence: item.confidence,
        evidence_count: item.evidence?.length ?? 0,
      },
    };
  },
};

export const updateMemoryTool: AgentTool<typeof updateMemorySchema._output> = {
  name: "update_memory",
  description:
    "Update an existing evidence-backed learning (content/category/importance/confidence/evidence or enabled/pinned state). Do not silently erase source evidence.",
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
        confidence: input.confidence,
        evidence: input.evidence,
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
