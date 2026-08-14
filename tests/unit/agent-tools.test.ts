import { describe, expect, it } from "vitest";
import { getToolByName, getToolDefinitions, listToolNames } from "@/lib/agent/tools";
import { executeToolCall } from "@/lib/agent/tool-runner";
import { generateImageSchema, zodToFunctionParameters } from "@/lib/agent/schemas";
import type { ToolContext } from "@/lib/agent/types";

const ctx: ToolContext = {
  requestId: "req",
  userId: "user",
  chatId: "chat",
  projectId: null,
  userMessageId: "msg",
  agentRunId: "run",
  userMessage: "hi",
  attachments: [],
};

describe("tool registry", () => {
  it("registers the required universal tools", () => {
    const names = listToolNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "answer_user",
        "generate_image",
        "generate_video",
        "search_knowledge",
        "add_to_knowledge",
        "list_knowledge_documents",
        "search_memory",
        "save_memory",
        "update_memory",
        "get_project_context",
        "list_project_files",
        "create_project",
        "update_project_instructions",
        "inspect_attachment",
        "extract_document",
        "web_search",
        "web_fetch",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("does not allow inventing tools", async () => {
    expect(getToolByName("drop_database")).toBeUndefined();
    const result = await executeToolCall(
      { id: "1", name: "drop_database", arguments: {} },
      ctx,
    );
    expect(result.result.ok).toBe(false);
    expect(result.result.code).toBe("TOOL_NOT_FOUND");
  });

  it("validates tool arguments with zod", async () => {
    const result = await executeToolCall(
      { id: "1", name: "generate_image", arguments: { prompt: "" } },
      ctx,
    );
    expect(result.result.ok).toBe(false);
    expect(result.result.code).toBe("VALIDATION_ERROR");
  });

  it("exposes JSON schema parameters for the provider", () => {
    const defs = getToolDefinitions();
    const image = defs.find((tool) => tool.name === "generate_image");
    expect(image?.parameters.type).toBe("object");
    const json = zodToFunctionParameters(generateImageSchema);
    expect(json.type).toBe("object");
  });
});
