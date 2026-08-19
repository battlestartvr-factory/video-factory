import {
  gameplayReferenceNeedSpecV1Schema,
  retrieveGameplayReferences,
  type GameplayReferenceCandidate,
  type GameplayReferenceNeedSpecV1,
  type PurposeLabeledGameplayReference,
  type PurposeLabeledGameplayReferenceSet,
} from "./gameplay-reference-retrieval";

const MAX_REFERENCES_PER_GAME = 2;
const PURPOSE_RANKING_DEPTH = 8;

type GameplayReferencePurpose = GameplayReferenceNeedSpecV1["purposes"][number];

function purposeNeed(input: {
  need: GameplayReferenceNeedSpecV1;
  purpose: GameplayReferencePurpose;
  candidateCount: number;
  requireCoopDependency: boolean;
}): GameplayReferenceNeedSpecV1 {
  const cameraPurpose = input.purpose === "gameplay_camera";
  const artPurpose = input.purpose === "art_direction";
  const mechanicEvidencePurpose = input.purpose === "interaction" || input.purpose === "coop";

  return gameplayReferenceNeedSpecV1Schema.parse({
    ...input.need,
    purposes: [input.purpose],
    maxResults: Math.min(PURPOSE_RANKING_DEPTH, Math.max(1, input.candidateCount)),
    // Camera grammar is a hard constraint only for the camera reference. Requiring the same
    // camera on co-op/art/interaction evidence can erase a useful library when a concept uses
    // a camera mode that is currently under-represented.
    cameraTypes: cameraPurpose ? input.need.cameraTypes : [],
    // Production scope is semantically owned by the art-direction reference. Other purposes
    // may come from a different-looking game as long as their gameplay evidence is useful.
    productionScopeFeel: artPurpose ? input.need.productionScopeFeel : [],
    requireCoopDependency: input.purpose === "coop" ? input.requireCoopDependency : false,
    requireSharedObject: mechanicEvidencePurpose ? (input.need.requireSharedObject ?? null) : null,
    requireVisibleRisk: mechanicEvidencePurpose ? (input.need.requireVisibleRisk ?? null) : null,
  });
}

function rankedForPurpose(input: {
  need: GameplayReferenceNeedSpecV1;
  purpose: GameplayReferencePurpose;
  candidates: GameplayReferenceCandidate[];
  requireCoopDependency: boolean;
}): PurposeLabeledGameplayReference[] {
  const scopedNeed = purposeNeed({
    need: input.need,
    purpose: input.purpose,
    candidateCount: input.candidates.length,
    requireCoopDependency: input.requireCoopDependency,
  });
  return retrieveGameplayReferences({ need: scopedNeed, candidates: input.candidates }).references;
}

/**
 * Reference requirements are purpose-specific. An excellent player-camera, interaction or
 * art-direction screenshot remains useful even when no teammate is visible. Explicit co-op
 * dependency is a hard requirement only for the CO-OP reference when the need requires it.
 *
 * Camera grammar is likewise hard only for the GAMEPLAY_CAMERA reference. A missing requested
 * camera therefore stays visible as a real library coverage gap instead of incorrectly removing
 * interaction/co-op/art evidence that is still useful for the same shot.
 *
 * Each purpose is ranked independently. Selection then applies global reference uniqueness
 * and a small same-game diversity cap, so one high-scoring frame cannot silently consume
 * several semantic roles.
 */
export function retrievePurposeAwareGameplayReferences(input: {
  need: GameplayReferenceNeedSpecV1;
  candidates: GameplayReferenceCandidate[];
}): PurposeLabeledGameplayReferenceSet {
  const need = gameplayReferenceNeedSpecV1Schema.parse(input.need);
  const selectedByPurpose = new Map<GameplayReferencePurpose, PurposeLabeledGameplayReference>();
  const selectedIds = new Set<string>();
  const gameCounts = new Map<string, number>();

  const choose = (purpose: GameplayReferencePurpose, requireCoopDependency: boolean) => {
    const ranked = rankedForPurpose({
      need,
      purpose,
      candidates: input.candidates,
      requireCoopDependency,
    });
    const chosen = ranked.find((item) => {
      if (selectedIds.has(item.reference.referenceId)) return false;
      return (gameCounts.get(item.reference.gameId) ?? 0) < MAX_REFERENCES_PER_GAME;
    });
    if (!chosen) return;
    selectedByPurpose.set(purpose, chosen);
    selectedIds.add(chosen.reference.referenceId);
    gameCounts.set(chosen.reference.gameId, (gameCounts.get(chosen.reference.gameId) ?? 0) + 1);
  };

  // Reserve explicit dependency evidence first so broad camera/art candidates can never
  // crowd the only strong co-op frame out of a compact four-reference set.
  if (need.purposes.includes("coop")) {
    choose("coop", need.requireCoopDependency);
  }

  // Camera is selected next because an exact requested camera can be scarce. The remaining
  // purposes are intentionally broader and cannot consume the camera slot first.
  if (need.purposes.includes("gameplay_camera")) {
    choose("gameplay_camera", false);
  }

  for (const purpose of need.purposes) {
    if (purpose === "coop" || purpose === "gameplay_camera") continue;
    choose(purpose, false);
  }

  return {
    schema: "purpose_labeled_gameplay_reference_set",
    version: 1,
    references: need.purposes
      .map((purpose) => selectedByPurpose.get(purpose))
      .filter((item): item is PurposeLabeledGameplayReference => Boolean(item))
      .slice(0, need.maxResults),
  };
}
