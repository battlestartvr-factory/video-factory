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

function rankedForPurpose(input: {
  need: GameplayReferenceNeedSpecV1;
  purpose: GameplayReferenceNeedSpecV1["purposes"][number];
  candidates: GameplayReferenceCandidate[];
  requireCoopDependency: boolean;
}): PurposeLabeledGameplayReference[] {
  const purposeNeed = gameplayReferenceNeedSpecV1Schema.parse({
    ...input.need,
    purposes: [input.purpose],
    maxResults: Math.min(PURPOSE_RANKING_DEPTH, Math.max(1, input.candidates.length)),
    requireCoopDependency: input.requireCoopDependency,
  });
  return retrieveGameplayReferences({ need: purposeNeed, candidates: input.candidates }).references;
}

/**
 * Reference requirements are purpose-specific. An excellent player-camera, interaction or
 * art-direction screenshot remains useful even when no teammate is visible. Explicit co-op
 * dependency is a hard requirement only for the CO-OP reference when the need requires it.
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
  const selectedByPurpose = new Map<
    GameplayReferenceNeedSpecV1["purposes"][number],
    PurposeLabeledGameplayReference
  >();
  const selectedIds = new Set<string>();
  const gameCounts = new Map<string, number>();

  const choose = (
    purpose: GameplayReferenceNeedSpecV1["purposes"][number],
    requireCoopDependency: boolean,
  ) => {
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

  for (const purpose of need.purposes) {
    if (purpose === "coop") continue;
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
