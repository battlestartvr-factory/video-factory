import { z } from "zod";
import {
  coopGameConceptSpecV1Schema,
  type CoopGameConceptSpecV1,
  type DiscoveryObjectiveSpecV1,
} from "./schemas";

const nonEmpty = z.string().trim().min(1);

/**
 * Human-first creative artifact for Game Discovery v3.
 *
 * The LLM owns the creative prose in `contentMarkdown`. The factory only needs
 * a stable identity/title around that prose. Deep design fields are deliberately
 * not part of this admission contract.
 */
export const conversationalGameConceptV2Schema = z.object({
  schema: z.literal("conversational_game_concept"),
  version: z.literal(2),
  conceptId: nonEmpty.max(160),
  title: nonEmpty.max(500),
  contentMarkdown: nonEmpty.max(20_000),
});

export type ConversationalGameConceptV2 = z.infer<typeof conversationalGameConceptV2Schema>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function getConversationalGameConceptV2(
  concept: CoopGameConceptSpecV1 | Record<string, unknown>,
): ConversationalGameConceptV2 | null {
  const metadata = object(concept.metadata);
  const parsed = conversationalGameConceptV2Schema.safeParse(metadata.v3ConceptArtifact);
  return parsed.success ? parsed.data : null;
}

/**
 * Deterministic bridge for the existing durable Stage 4 persistence/state
 * machine. This is NOT a creative validation gate: the authoritative concept
 * remains metadata.v3ConceptArtifact.contentMarkdown and v3 downstream LLM
 * stages prefer that full text.
 */
export function projectConversationalConceptToLegacy(input: {
  artifact: ConversationalGameConceptV2;
  objective: DiscoveryObjectiveSpecV1;
  sourceRefs: string[];
  rawResponseHash?: string;
}): CoopGameConceptSpecV1 {
  const artifact = conversationalGameConceptV2Schema.parse(input.artifact);
  const content = clip(artifact.contentMarkdown, 2_000);
  const contentShort = clip(artifact.contentMarkdown, 1_500);
  const roleCount = input.objective.playerCount.max;
  const networking = input.objective.constraints.networkingComplexity ?? "medium";
  const contentBurden = input.objective.constraints.contentBurden ?? "medium";
  const npcAiDependency = input.objective.constraints.npcAiDependency === "allow_light" ? "light" : "none";

  return coopGameConceptSpecV1Schema.parse({
    schema: "coop_game_concept",
    version: 1,
    conceptId: artifact.conceptId,
    oneSentencePitch: clip(artifact.title, 500),
    coreMechanic: content,
    coopDependency: content,
    playerRoles: Array.from({ length: roleCount }, (_, index) => ({
      role: `Игрок ${index + 1}`,
      responsibility: "Конкретная роль и взаимозависимость описаны в полном утверждаемом концепте.",
    })),
    playerCount: {
      min: input.objective.playerCount.min,
      max: input.objective.playerCount.max,
      ideal: input.objective.playerCount.max,
    },
    interactionModel: ["Полный игровой замысел сохранён как conversational artifact"],
    failureMode: content,
    socialMoment: content,
    gameplayHook: contentShort,
    spectacle: contentShort,
    setting: contentShort,
    artDirection: contentShort,
    camera: "Определяется Gameplay Moment Planner из полного утверждённого концепта.",
    readability: "Определяется Gameplay Moment Planner из полного утверждённого концепта.",
    noveltyAxes: [
      {
        axis: "creative_artifact",
        choice: "human_first_concept",
        whyDifferent: "Полный творческий замысел хранится как человеческий текст, а не как обязательная внутренняя анкета.",
      },
      {
        axis: "workflow",
        choice: "strong_llm_then_human_gate",
        whyDifferent: "Сильная LLM создаёт идею целиком, после чего решение принимает человек.",
      },
    ],
    buildability: {
      networking,
      physics: "medium",
      contentBurden,
      npcAiDependency,
      systemicInteractions: "medium",
      mainRisks: [],
      mvpRead: input.objective.constraints.maxMvpMonths
        ? `MVP-ограничение исходного запроса: до ${input.objective.constraints.maxMvpMonths} месяцев.`
        : "Buildability оценивается только когда это действительно нужно для производства.",
    },
    referenceInfluences: [],
    metadata: {
      v3ConceptArtifact: artifact,
      v3SourceRefs: input.sourceRefs,
      ...(input.rawResponseHash ? { v3RawResponseHash: input.rawResponseHash } : {}),
      legacyCompatibilityProjection: true,
    },
  });
}
