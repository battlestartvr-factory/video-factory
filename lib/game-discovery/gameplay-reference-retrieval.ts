import { z } from "zod";
import {
  gameplayReferenceCameraTypeSchema,
  gameplayReferenceProductionScopeFeelSchema,
  gameplayReferencePurposeSchema,
  type GameplayReferencePurpose,
} from "./gameplay-reference-schema";
import type { GameplayMomentSpecV1, ShotSpecV1 } from "./schemas";

const shortText = z.string().trim().min(1).max(240);

export const gameplayReferenceNeedSpecV1Schema = z
  .object({
    schema: z.literal("gameplay_reference_need"),
    version: z.literal(1),
    queryText: z.string().trim().min(1).max(8_000),
    cameraTypes: z.array(gameplayReferenceCameraTypeSchema).max(6).default([]),
    mechanicTags: z.array(shortText).max(30).default([]),
    interactionModel: z.array(shortText).max(20).default([]),
    playerAction: z.string().trim().min(1).max(2_000).nullable().optional(),
    requireCoopDependency: z.boolean().default(true),
    requireSharedObject: z.boolean().nullable().optional(),
    requireVisibleRisk: z.boolean().nullable().optional(),
    productionScopeFeel: z.array(gameplayReferenceProductionScopeFeelSchema).max(3).default([]),
    stylizationTags: z.array(shortText).max(30).default([]),
    highReadability: z.boolean().default(true),
    purposes: z.array(gameplayReferencePurposeSchema).min(1).max(4),
    maxResults: z.number().int().min(1).max(8).default(8),
  })
  .strict();

export type GameplayReferenceNeedSpecV1 = z.infer<typeof gameplayReferenceNeedSpecV1Schema>;

export interface GameplayReferenceCandidate {
  referenceId: string;
  gameId: string;
  gameName: string;
  driveFileId: string;
  sourceUrl: string;
  cameraType: z.infer<typeof gameplayReferenceCameraTypeSchema>;
  controllablePlayerObvious: boolean;
  handsVisible: boolean | null;
  heldToolVisible: boolean | null;
  crosshairVisible: boolean | null;
  hudVisible: boolean | null;
  teammateCountVisible: number;
  coopDependencyVisible: boolean;
  sharedObjectVisible: boolean;
  coordinationVisible: boolean;
  coreAction: string;
  currentPlayerAction: string;
  visibleInputAffordance: string;
  gameResponse: string;
  mechanicTags: string[];
  interactionModel: string[];
  failureRisk: string | null;
  dangerSource: string | null;
  physicsInteraction: string | null;
  readableWithoutContext: boolean;
  visibleGoal: boolean;
  visibleRisk: boolean;
  uiSupportsAction: boolean;
  productionScopeFeel: z.infer<typeof gameplayReferenceProductionScopeFeelSchema>;
  stylizationTags: string[];
  artDirection: string;
  gameplayDescription: string;
  whyThisLooksLikeGameplay: string;
  semanticSimilarity?: number | null;
}

export interface PurposeLabeledGameplayReference {
  purpose: GameplayReferencePurpose;
  reference: GameplayReferenceCandidate;
  score: number;
  whySelected: string[];
}

export interface PurposeLabeledGameplayReferenceSet {
  schema: "purpose_labeled_gameplay_reference_set";
  version: 1;
  references: PurposeLabeledGameplayReference[];
}

function normalizedTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 3),
  );
}

function overlapScore(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const right = new Set(b.map((item) => item.toLowerCase()));
  const matched = a.filter((item) => right.has(item.toLowerCase())).length;
  return matched / Math.max(1, Math.min(a.length, b.length));
}

function textSimilarity(query: string, candidate: GameplayReferenceCandidate): number {
  const queryTokens = normalizedTokens(query);
  if (!queryTokens.size) return 0;
  const candidateTokens = normalizedTokens(
    [
      candidate.coreAction,
      candidate.currentPlayerAction,
      candidate.visibleInputAffordance,
      candidate.gameResponse,
      candidate.failureRisk ?? "",
      candidate.dangerSource ?? "",
      candidate.physicsInteraction ?? "",
      candidate.gameplayDescription,
      candidate.whyThisLooksLikeGameplay,
      candidate.mechanicTags.join(" "),
      candidate.interactionModel.join(" "),
    ].join(" "),
  );
  let matches = 0;
  for (const token of queryTokens) if (candidateTokens.has(token)) matches += 1;
  return matches / queryTokens.size;
}

function purposeScore(
  purpose: GameplayReferencePurpose,
  need: GameplayReferenceNeedSpecV1,
  candidate: GameplayReferenceCandidate,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const semantic = candidate.semanticSimilarity ?? textSimilarity(need.queryText, candidate);
  score += Math.max(0, Math.min(1, semantic)) * 0.25;
  if (semantic > 0.35) reasons.push("semantic gameplay match");

  const cameraMatch = need.cameraTypes.length === 0 || need.cameraTypes.includes(candidate.cameraType);
  if (cameraMatch) {
    score += 0.12;
    if (need.cameraTypes.length) reasons.push(`camera ${candidate.cameraType}`);
  }

  const mechanic = overlapScore(need.mechanicTags, candidate.mechanicTags);
  const interaction = overlapScore(need.interactionModel, candidate.interactionModel);
  score += mechanic * 0.13 + interaction * 0.08;
  if (mechanic > 0) reasons.push("mechanic overlap");
  if (interaction > 0) reasons.push("interaction-model overlap");

  if (!need.requireCoopDependency || candidate.coopDependencyVisible) {
    score += 0.08;
    if (candidate.coopDependencyVisible) reasons.push("visible co-op dependency");
  }
  if (need.requireSharedObject == null || need.requireSharedObject === candidate.sharedObjectVisible) {
    score += 0.04;
  }
  if (need.requireVisibleRisk == null || need.requireVisibleRisk === candidate.visibleRisk) {
    score += 0.04;
  }
  if (need.highReadability && candidate.readableWithoutContext) {
    score += 0.06;
    reasons.push("readable without context");
  }

  const scopeMatch =
    need.productionScopeFeel.length === 0 ||
    need.productionScopeFeel.includes(candidate.productionScopeFeel);
  const style = overlapScore(need.stylizationTags, candidate.stylizationTags);
  if (scopeMatch) score += 0.04;
  score += style * 0.04;

  switch (purpose) {
    case "gameplay_camera": {
      if (candidate.controllablePlayerObvious) {
        score += 0.1;
        reasons.push("controllable player is obvious");
      }
      if (
        candidate.handsVisible ||
        candidate.heldToolVisible ||
        candidate.crosshairVisible ||
        candidate.hudVisible
      ) {
        score += 0.06;
        reasons.push("player-bound gameplay affordance");
      }
      break;
    }
    case "interaction": {
      if (candidate.heldToolVisible) {
        score += 0.07;
        reasons.push("held tool is visible");
      }
      if (candidate.visibleInputAffordance.trim()) score += 0.05;
      if (candidate.gameResponse.trim()) {
        score += 0.05;
        reasons.push("input-to-world response is legible");
      }
      break;
    }
    case "coop": {
      if (candidate.teammateCountVisible > 0) {
        score += 0.07;
        reasons.push("teammate is inside gameplay frame");
      }
      if (candidate.coordinationVisible || candidate.sharedObjectVisible) {
        score += 0.08;
        reasons.push("coordination/shared dependency is visible");
      }
      break;
    }
    case "art_direction": {
      if (scopeMatch) {
        score += 0.08;
        reasons.push(`production scope ${candidate.productionScopeFeel}`);
      }
      if (style > 0) {
        score += 0.08;
        reasons.push("stylization overlap");
      }
      break;
    }
  }

  return { score: Math.min(1, score), reasons };
}

export function retrieveGameplayReferences(input: {
  need: GameplayReferenceNeedSpecV1;
  candidates: GameplayReferenceCandidate[];
}): PurposeLabeledGameplayReferenceSet {
  const need = gameplayReferenceNeedSpecV1Schema.parse(input.need);
  const candidates = input.candidates.filter((candidate) => {
    if (need.cameraTypes.length && !need.cameraTypes.includes(candidate.cameraType)) return false;
    if (need.requireCoopDependency && !candidate.coopDependencyVisible) return false;
    if (need.requireSharedObject != null && need.requireSharedObject !== candidate.sharedObjectVisible) {
      return false;
    }
    if (need.requireVisibleRisk != null && need.requireVisibleRisk !== candidate.visibleRisk) return false;
    if (
      need.productionScopeFeel.length &&
      !need.productionScopeFeel.includes(candidate.productionScopeFeel)
    ) {
      return false;
    }
    return true;
  });

  const scored = need.purposes.flatMap((purpose) =>
    candidates.map((candidate) => {
      const scoredCandidate = purposeScore(purpose, need, candidate);
      return {
        purpose,
        reference: candidate,
        score: scoredCandidate.score,
        whySelected: scoredCandidate.reasons,
      } satisfies PurposeLabeledGameplayReference;
    }),
  );

  const selected: PurposeLabeledGameplayReference[] = [];
  const selectedIds = new Set<string>();
  const gameCounts = new Map<string, number>();

  // First guarantee purpose coverage where possible.
  for (const purpose of need.purposes) {
    const best = scored
      .filter((item) => item.purpose === purpose && !selectedIds.has(item.reference.referenceId))
      .sort((a, b) => b.score - a.score)
      .find((item) => (gameCounts.get(item.reference.gameId) ?? 0) < 2);
    if (!best) continue;
    selected.push(best);
    selectedIds.add(best.reference.referenceId);
    gameCounts.set(best.reference.gameId, (gameCounts.get(best.reference.gameId) ?? 0) + 1);
    if (selected.length >= need.maxResults) break;
  }

  // Fill remaining slots while penalizing same-game repetition and exact camera repetition.
  while (selected.length < need.maxResults) {
    const cameraCounts = new Map<string, number>();
    for (const item of selected) {
      cameraCounts.set(
        item.reference.cameraType,
        (cameraCounts.get(item.reference.cameraType) ?? 0) + 1,
      );
    }

    const next = scored
      .filter((item) => !selectedIds.has(item.reference.referenceId))
      .map((item) => {
        const sameGame = gameCounts.get(item.reference.gameId) ?? 0;
        const sameCamera = cameraCounts.get(item.reference.cameraType) ?? 0;
        return { item, adjusted: item.score - sameGame * 0.15 - sameCamera * 0.025 };
      })
      .filter(({ item }) => (gameCounts.get(item.reference.gameId) ?? 0) < 2)
      .sort((a, b) => b.adjusted - a.adjusted)[0]?.item;

    if (!next) break;
    selected.push(next);
    selectedIds.add(next.reference.referenceId);
    gameCounts.set(next.reference.gameId, (gameCounts.get(next.reference.gameId) ?? 0) + 1);
  }

  return {
    schema: "purpose_labeled_gameplay_reference_set",
    version: 1,
    references: selected,
  };
}

function inferCameraTypes(text: string): GameplayReferenceNeedSpecV1["cameraTypes"] {
  const normalized = text.toLowerCase();
  const result: GameplayReferenceNeedSpecV1["cameraTypes"] = [];
  if (/first[- ]person|\bfp\b|pov/.test(normalized)) result.push("first_person");
  if (/third[- ]person|follow camera|\btp\b/.test(normalized)) result.push("third_person_follow");
  if (/over[- ](?:the[- ])?shoulder/.test(normalized)) result.push("over_shoulder");
  if (/top[- ]down/.test(normalized)) result.push("top_down");
  return [...new Set(result)];
}

/**
 * Transitional deterministic adapter from today's GameplayMoment/Shot contract into the
 * new typed retrieval contract. Later planners may provide richer mechanic/style filters,
 * but retrieval never needs raw prompt text as its API.
 */
export function buildGameplayReferenceNeed(input: {
  moment: GameplayMomentSpecV1;
  shot: ShotSpecV1;
  mechanicTags?: string[];
  interactionModel?: string[];
  productionScopeFeel?: GameplayReferenceNeedSpecV1["productionScopeFeel"];
  stylizationTags?: string[];
  requireSharedObject?: boolean | null;
  requireVisibleRisk?: boolean | null;
  maxResults?: number;
}): GameplayReferenceNeedSpecV1 {
  const queryText = [
    input.moment.hypothesis,
    input.moment.setup,
    input.moment.coopDependencyEvidence,
    input.moment.socialTension,
    input.moment.expectedViewerUnderstanding,
    input.moment.cameraIntent,
    input.moment.requiredVisualEvidence.join("; "),
    input.moment.playerActions
      .map((action) => `${action.role}: ${action.action}; dependency: ${action.dependencyOnOthers}`)
      .join("\n"),
    input.shot.action,
    input.shot.camera,
    input.shot.environment,
    input.shot.expectedEvidence.join("; "),
  ].join("\n");

  return gameplayReferenceNeedSpecV1Schema.parse({
    schema: "gameplay_reference_need",
    version: 1,
    queryText,
    cameraTypes: inferCameraTypes(`${input.moment.cameraIntent}\n${input.shot.camera}`),
    mechanicTags: input.mechanicTags ?? [],
    interactionModel: input.interactionModel ?? [],
    playerAction: input.moment.playerActions[0]?.action ?? null,
    requireCoopDependency: true,
    requireSharedObject: input.requireSharedObject ?? null,
    requireVisibleRisk: input.requireVisibleRisk ?? null,
    productionScopeFeel: input.productionScopeFeel ?? [],
    stylizationTags: input.stylizationTags ?? [],
    highReadability: true,
    purposes: ["gameplay_camera", "interaction", "coop", "art_direction"],
    maxResults: input.maxResults ?? 8,
  });
}
