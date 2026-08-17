import { describe, expect, it } from "vitest";
import { MAX_TOOLS_PER_REQUEST, TOOL_GROUPS } from "@/lib/agent/tools/resolve-tools-for-turn";
import { detectTurnIntent, resolveToolsForTurn } from "@/lib/agent/tools/resolve-tools-for-turn";
import { getToolDefinitions } from "@/lib/agent/tools";

describe("resolveToolsForTurn", () => {
  it('"Привет" → 0 tools (general conversation)', () => {
    const result = resolveToolsForTurn({ userMessage: "Привет" });
    expect(result.intent).toBe("general");
    expect(result.tools).toHaveLength(0);
    expect(result.toolNames).toEqual([]);
  });

  it("knowledge request → only knowledge tools", () => {
    const result = resolveToolsForTurn({
      userMessage: 'Расскажи про урок 3 «Волшебная копилка» из базы знаний',
    });
    expect(result.intent).toBe("knowledge");
    expect(result.toolNames).toEqual(expect.arrayContaining(["search_knowledge", "list_knowledge_documents"]));
    for (const name of result.toolNames) expect(TOOL_GROUPS.knowledge).toContain(name);
  });

  it("image request → image-related tools", () => {
    const result = resolveToolsForTurn({ userMessage: "Сгенерируй изображение заката над морем" });
    expect(result.intent).toBe("image");
    expect(result.toolNames).toContain("generate_image");
  });

  it("video request → video-related tools", () => {
    const result = resolveToolsForTurn({ userMessage: "Создай видео про космос" });
    expect(result.intent).toBe("video");
    expect(result.toolNames).toContain("generate_video");
  });

  it("memory request → memory tools", () => {
    const result = resolveToolsForTurn({ userMessage: "Запомни этот вывод для будущих экспериментов" });
    expect(result.intent).toBe("memory");
    expect(result.toolNames).toContain("save_memory");
  });

  it("document-to-memory request exposes extraction and memory tools", () => {
    const result = resolveToolsForTurn({
      userMessage: "Проанализируй этот срез рынка и запомни важные инсайты в память",
      attachmentIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(result.intent).toBe("memory");
    expect(result.toolNames).toEqual(
      expect.arrayContaining(["inspect_attachment", "extract_document", "save_memory"]),
    );
  });

  it("web request → web tools", () => {
    const result = resolveToolsForTurn({ userMessage: "Найди в интернете последние новости про AI" });
    expect(result.intent).toBe("web");
    expect(result.toolNames.every((name) => TOOL_GROUPS.web.includes(name))).toBe(true);
  });

  it("project request → project tools", () => {
    const result = resolveToolsForTurn({
      userMessage: "Покажи файлы проекта",
      projectId: "00000000-0000-4000-8000-000000000001",
    });
    expect(result.intent).toBe("projects");
    expect(result.toolNames.every((name) => TOOL_GROUPS.projects.includes(name))).toBe(true);
  });

  it("no turn gets more than hard cap", () => {
    const samples = [
      "Привет",
      "Найди в базе знаний про урок",
      "Сгенерируй картинку",
      "Создай видео",
      "Запомни это",
      "Найди в интернете",
      "Покажи файлы проекта",
    ];
    for (const userMessage of samples) {
      expect(resolveToolsForTurn({ userMessage }).tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_REQUEST);
    }
  });

  it("never returns the full registry", () => {
    const registrySize = getToolDefinitions().length;
    const result = resolveToolsForTurn({ userMessage: "Сделай всё: найди в базе, сгенерируй картинку и видео" });
    expect(result.tools.length).toBeLessThan(registrySize);
    expect(result.tools.length).toBeLessThanOrEqual(MAX_TOOLS_PER_REQUEST);
  });
});

describe("detectTurnIntent", () => {
  it("classifies greetings as general", () => {
    expect(detectTurnIntent({ userMessage: "Привет!" })).toBe("general");
    expect(detectTurnIntent({ userMessage: "Hello" })).toBe("general");
  });
});
