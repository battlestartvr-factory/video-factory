import { describe, expect, it } from "vitest";
import { getConversationalGameConceptV2 } from "../../lib/game-discovery/conversational-concept";
import type { DiscoveryObjectiveSpecV1 } from "../../lib/game-discovery/schemas";
import {
  gameDiscoveryResearchPackV1Schema,
  generateStrongConceptBatch,
} from "../../lib/research-intelligence/game-discovery-v3";

const objective: DiscoveryObjectiveSpecV1 = {
  schema: "discovery_objective",
  version: 1,
  objectiveId: "objective-conversational-v3",
  title: "Игры для четырёх друзей",
  searchIntent: "Придумай три разные кооперативные игры для четырёх друзей про путешествия.",
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

const pack = gameDiscoveryResearchPackV1Schema.parse({
  schema: "game_discovery_research_pack",
  version: 1,
  researchRunId: "research-conversational-v3",
  objectiveId: objective.objectiveId,
  sources: [
    {
      sourceRef: "source-a",
      canonicalUrl: "https://example.com/a",
      title: "Source A",
      groundedClaims: ["Friends value readable co-op dependency."],
      categories: ["mechanics", "player_voice"],
      observedAt: "2026-08-22T07:00:00.000Z",
    },
    {
      sourceRef: "source-b",
      canonicalUrl: "https://example.com/b",
      title: "Source B",
      groundedClaims: ["Traversal failures are memorable when players can understand the cause."],
      categories: ["competitor", "gameplay_visual"],
      observedAt: "2026-08-22T07:00:00.000Z",
    },
  ],
  coverage: { total_sources: 2, competitor: 1, mechanics: 1, player_voice: 1, gameplay_visual: 1, contrarian: 0 },
  generatedAt: "2026-08-22T07:00:00.000Z",
  usage: {},
});

function response(text: string) {
  return {
    text,
    usage: { inputTokens: 100, outputTokens: 500, totalTokens: 600 },
    stopReason: "end_turn",
    responsePayload: {},
  };
}

describe("Game Discovery v3 conversational concepts", () => {
  it("accepts rich human concepts without requiring the legacy deep questionnaire", async () => {
    const raw = {
      schema: "strong_concept_batch",
      version: 1,
      researchRunId: pack.researchRunId,
      concepts: [
        {
          concept: {
            conceptId: "trail-radio",
            oneSentencePitch: "Поход, где четверо друзей держат связь через нестабильную радиосеть.",
            coreMechanic: "Игроки физически расходятся по маршруту и передают ориентиры голосом и переносными ретрансляторами.",
            coopDependency: "Никто не видит всю картину одновременно.",
            playerRoles: ["разведчик", "картограф", "связист", "носильщик"],
            buildability: { networking: "moderate", mvpMonths: 8 },
          },
          sourceRefs: ["source-a", "source-b"],
        },
        {
          concept: {
            conceptId: "night-bus",
            title: "Последний автобус",
            contentMarkdown: "Четверо друзей ночью ведут разваливающийся автобус через живой город. Один рулит, остальные на ходу чинят системы, ищут дорогу и договариваются с пассажирами. Ошибка одного мгновенно создаёт проблему для остальных, поэтому каждая поездка превращается в совместную историю.",
          },
          sourceRefs: ["source-a", "source-b"],
        },
        {
          concept: {
            conceptId: "moving-camp",
            oneSentencePitch: "Кочующий лагерь",
            coreMechanic: "Команда переносит один общий лагерь через опасную открытую местность, постоянно решая, что оставить, что нести и где остановиться.",
            failureMode: "Плохое распределение веса или неверный маршрут заставляют друзей спасать вещи и друг друга.",
            socialMoment: "Все одновременно спорят, какой предмет бросить, пока погода уничтожает лагерь.",
          },
          sourceRefs: ["source-a", "source-b"],
        },
      ],
    };

    const result = await generateStrongConceptBatch({
      objective,
      pack,
      llm: { generate: async () => response(JSON.stringify(raw)) },
    });

    expect(result.attempts).toBe(1);
    expect(result.batch.concepts).toHaveLength(3);
    const artifacts = result.batch.concepts.map((candidate) => getConversationalGameConceptV2(candidate.concept));
    expect(artifacts.every(Boolean)).toBe(true);
    expect(artifacts[0]?.title).toContain("Поход");
    expect(artifacts[0]?.contentMarkdown).toContain("Игроки физически расходятся");
    expect(artifacts[1]?.contentMarkdown).toContain("разваливающийся автобус");
    expect(result.batch.concepts[0]?.concept.metadata?.legacyCompatibilityProjection).toBe(true);
  });

  it("keeps the model-facing v2 envelope intentionally small", async () => {
    const raw = {
      schema: "strong_concept_batch",
      version: 2,
      researchRunId: pack.researchRunId,
      concepts: ["one", "two", "three"].map((id, index) => ({
        concept: {
          schema: "conversational_game_concept",
          version: 2,
          conceptId: id,
          title: `Идея ${index + 1}`,
          contentMarkdown: `Полный человеческий концепт ${index + 1}: игроки делают разные совместные действия и получают отличающийся тип провала.`,
          ignoredExtraField: "extra model creativity must not fail admission",
        },
        sourceRefs: ["source-a", "source-b"],
        ignoredCandidateField: true,
      })),
      ignoredTopLevelField: true,
    };

    const result = await generateStrongConceptBatch({
      objective,
      pack,
      llm: { generate: async () => response(JSON.stringify(raw)) },
    });

    expect(result.batch.concepts.map((item) => item.concept.conceptId)).toEqual(["one", "two", "three"]);
  });
});
