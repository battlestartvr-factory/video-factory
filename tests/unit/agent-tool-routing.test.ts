import { describe, expect, it } from "vitest";
import { detectTurnIntent } from "@/lib/agent/tools/resolve-tools-for-turn";

describe("agent tool intent routing", () => {
  it.each([
    "Повтори запуск поиска новой co-op игры по тому же research",
    "Перезапусти discovery co-op игры",
    "Запусти поиск новой кооп игры ещё раз",
  ])("routes Stage 4 retry command to game discovery: %s", (userMessage) => {
    expect(detectTurnIntent({ userMessage })).toBe("game_discovery");
  });
});
