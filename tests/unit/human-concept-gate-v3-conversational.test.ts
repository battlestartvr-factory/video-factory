import { describe, expect, it, vi } from "vitest";
import {
  conversationalGameConceptV2Schema,
  getConversationalGameConceptV2,
  projectConversationalConceptToLegacy,
  type ConversationalGameConceptV2,
} from "../../lib/game-discovery/conversational-concept";
import {
  applyHumanConceptReviews,
  type HumanConceptReviewState,
} from "../../lib/game-discovery/human-concept-gate";
import type {
  CoopGameConceptSpecV1,
  DiscoveryObjectiveSpecV1,
} from "../../lib/game-discovery/schemas";

const objective: DiscoveryObjectiveSpecV1 = {
  schema: "discovery_objective",
  version: 1,
  objectiveId: "v3-human-gate",
  title: "Игра для четырёх друзей",
  searchIntent: "Придумать кооперативную игру для четырёх друзей.",
  playerCount: { min: 2, max: 4 },
  platform: "pc_steam",
  desiredNovelty: "explore",
  conceptCount: 3,
  maxConceptsToPrototype: 3,
  constraints: {
    maxMvpMonths: 12,
    networkingComplexity: "medium",
    contentBurden: "medium",
    npcAiDependency: "allow_light",
  },
  metadata: {},
};

function artifact(id: string, title: string, body: string): ConversationalGameConceptV2 {
  return conversationalGameConceptV2Schema.parse({
    schema: "conversational_game_concept",
    version: 2,
    conceptId: id,
    title,
    contentMarkdown: body,
  });
}

function projected(value: ConversationalGameConceptV2, refs = ["source-a", "source-b"]): CoopGameConceptSpecV1 {
  return projectConversationalConceptToLegacy({ artifact: value, objective, sourceRefs: refs });
}

function review(
  conceptId: string,
  decision: HumanConceptReviewState["decision"],
  rawFeedback: string,
): HumanConceptReviewState {
  return {
    conceptRunId: `run-${conceptId}`,
    conceptId,
    decision,
    rawFeedback,
    reviewId: `review-${conceptId}`,
  };
}

function llmWithArtifacts(values: ConversationalGameConceptV2[]) {
  const queue = [...values];
  return {
    generate: vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error("unexpected LLM call");
      return {
        text: JSON.stringify({ concept: next }),
        usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
        stopReason: "stop",
        responsePayload: {},
      };
    }),
  };
}

describe("Game Discovery v3 conversational Human Concept Gate", () => {
  it("revises a v3 concept through the tiny human-facing artifact instead of the deep legacy schema", async () => {
    const source = projected(artifact(
      "shared-storm",
      "Штормовой экипаж",
      "# Штормовой экипаж\n\nЧетверо друзей удерживают один летающий корабль в грозе: один ловит потоки, второй перераспределяет энергию, третий чинит разрывы, четвёртый прокладывает маршрут. Ошибки одного немедленно создают проблему другим.",
    ));
    const revisedArtifact = artifact(
      "provider-id-does-not-own-lineage",
      "Штормовой экипаж: живой корабль",
      "# Штормовой экипаж: живой корабль\n\nЭто всё та же игра о четырёх друзьях, которые вместе удерживают воздушный корабль в грозе, но теперь корабль — живое существо. Игроки одновременно успокаивают его, направляют крылья, лечат повреждения и выбирают опасный маршрут; паника существа связывает ошибки команды в одну понятную цепочку последствий.",
    );
    const llm = llmWithArtifacts([revisedArtifact]);

    const result = await applyHumanConceptReviews({
      llm,
      objective,
      activeConcepts: [source],
      reviews: [review(source.conceptId, "revise", "Сохрани механику, но сделай корабль живым существом.")],
      history: [source],
    });

    expect(result.attempts).toBe(1);
    expect(result.activeConcepts).toHaveLength(1);
    const revised = result.activeConcepts[0]!;
    const humanArtifact = getConversationalGameConceptV2(revised);
    expect(humanArtifact?.title).toBe("Штормовой экипаж: живой корабль");
    expect(humanArtifact?.contentMarkdown).toContain("корабль — живое существо");
    expect(humanArtifact?.conceptId).toMatch(/^shared-storm-rev-/);
    expect(revised.metadata?.v3SourceRefs).toEqual(["source-a", "source-b"]);
    expect(revised.metadata?.humanReviewLineage).toMatchObject({
      action: "revise",
      sourceConceptId: "shared-storm",
      humanFeedback: "Сохрани механику, но сделай корабль живым существом.",
    });

    const call = llm.generate.mock.calls[0]?.[0];
    expect(call?.prompt).toContain("contentMarkdown");
    expect(call?.prompt).toContain("не реконструировать старую schema");
    expect(call?.prompt).not.toContain("npcAiDependency:\"none\"|\"light\"|\"heavy\"");
  });

  it("creates a fresh all-rejected v3 cycle using only conversational artifacts", async () => {
    const active = [
      projected(artifact(
        "old-a",
        "Магнитный док",
        "Друзья управляют полюсами одного магнитного крана и совместно таскают тяжёлый груз через индустриальный док.",
      )),
      projected(artifact(
        "old-b",
        "Слепой лабиринт",
        "Один видит маршрут, другие двигают платформы и передают друг другу неполную информацию внутри тёмного лабиринта.",
      )),
      projected(artifact(
        "old-c",
        "Общий баланс",
        "Четыре игрока стоят на разных краях огромной качающейся платформы и удерживают груз от падения.",
      )),
    ];
    const next = [
      artifact(
        "fresh-a",
        "Оркестр чудовищ",
        "Четверо друзей дрессируют огромное музыкальное чудовище: каждый управляет отдельной группой мышц, а ритм команды превращает хаотичные движения в совместные атаки и нелепые провалы на сцене.",
      ),
      artifact(
        "fresh-b",
        "Курьеры времени",
        "Команда застряла в четырёх версиях одной улицы в разные десятилетия. Действие в прошлом меняет препятствия у друзей в будущем, поэтому каждый постоянно строит путь не себе, а товарищу в другой эпохе.",
      ),
      artifact(
        "fresh-c",
        "Погружение в сон",
        "Четверо друзей одновременно находятся в разных слоях одного сна. Каждый может менять только физическое правило своего слоя, а безопасный путь возникает лишь когда правила складываются в правильную последовательность.",
      ),
    ];
    const llm = llmWithArtifacts(next);

    const result = await applyHumanConceptReviews({
      llm,
      objective,
      activeConcepts: active,
      reviews: active.map((concept) => review(concept.conceptId, "reject", "Нужен полностью новый цикл.")),
      history: active,
    });

    expect(result.activeConcepts).toHaveLength(3);
    expect(result.regeneratedConcepts).toHaveLength(3);
    expect(result.attempts).toBe(3);
    expect(llm.generate).toHaveBeenCalledTimes(3);
    expect(result.activeConcepts.every((concept) => Boolean(getConversationalGameConceptV2(concept)))).toBe(true);
    expect(result.activeConcepts.map((concept) => getConversationalGameConceptV2(concept)?.title)).toEqual([
      "Оркестр чудовищ",
      "Курьеры времени",
      "Погружение в сон",
    ]);
    expect(result.activeConcepts.every(
      (concept) => (concept.metadata?.humanReviewLineage as { action?: string } | undefined)?.action === "new_cycle",
    )).toBe(true);

    for (const [call] of llm.generate.mock.calls) {
      expect(call.prompt).toContain("contentMarkdown");
      expect(call.prompt).not.toContain("buildability: {networking");
    }
  });
});
