import { describe, expect, it } from "vitest";
import {
  detectTurnIntent,
  isNaturalGameDesignRequest,
  resolveToolsForTurn,
} from "../../lib/agent/tools/resolve-tools-for-turn";

const babiesPrompt = `Я придумал игру догонялки карапузов. Смешная игра где в догонялки на детской площадке играют карапузы, но используют нереалистичные способности, крюк кошка, мегафон отталкивающий, грави граната вокруг большой стадион с кучей зрителей, все подается под супер спортивным соусом, когда происходит интересные события слышно как публика ликует.

Подумай как это может выглядеть, если можешь то усиль мою концепцию или доработай её. Можешь также вносить изменения в базовую но только если есть что предложить посильнее. Я хочу в итоге получить питчинг игры, как будто ты пытаешься продать мне её как игроку 20-35 лет, который любит играть с друзьями по вечерам.`;

describe("natural chat → Game Discovery v3 routing", () => {
  it("routes the real seeded babies-tag brief to deterministic discovery", () => {
    expect(isNaturalGameDesignRequest(babiesPrompt)).toBe(true);
    expect(detectTurnIntent({ userMessage: babiesPrompt })).toBe("game_discovery");
    expect(resolveToolsForTurn({ userMessage: babiesPrompt }).toolNames).toEqual(["start_game_discovery"]);
  });

  it.each([
    "Придумай мне 3 разные кооперативные игры от первого лица для четырёх друзей про походы.",
    "У меня есть игра про карапузов. Доработай механику и предложи более сильный вариант концепции.",
    "Вот моя концепция co-op game. Что думаешь и как её улучшить, чтобы друзья реально зависели друг от друга?",
    "Design three mechanically different co-op games for four friends in an open city.",
  ])("routes ordinary game-design language without internal factory keywords: %s", (userMessage) => {
    expect(detectTurnIntent({ userMessage })).toBe("game_discovery");
  });

  it.each([
    "Напиши рекламный пост для моей игры в Telegram.",
    "Придумай слоган для Steam страницы игры.",
    "Сделай картинку для игры про карапузов.",
    "Напиши рассказ про друзей в походе.",
  ])("does not hijack unrelated creative/media requests: %s", (userMessage) => {
    expect(detectTurnIntent({ userMessage })).not.toBe("game_discovery");
  });
});
