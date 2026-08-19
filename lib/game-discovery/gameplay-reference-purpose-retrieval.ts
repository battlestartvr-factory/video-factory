import {
  gameplayReferenceNeedSpecV1Schema,
  retrieveGameplayReferences,
  type GameplayReferenceCandidate,
  type GameplayReferenceNeedSpecV1,
  type PurposeLabeledGameplayReference,
  type PurposeLabeledGameplayReferenceSet,
} from "./gameplay-reference-retrieval";

/**
 * Co-op dependency is evidence required from the CO-OP reference, not from every visual
 * reference in the set. Requiring it globally starves useful camera/interaction/art refs
 * when a screenshot is excellent gameplay grammar but does not happen to show a teammate.
 *
 * This adapter reserves the strongest explicit co-op frame first, then retrieves the other
 * purposes from the broader gameplay pool while excluding that reserved frame. The output
 * remains one typed purpose-labeled set and keeps the original requested purpose order.
 */
export function retrievePurposeAwareGameplayReferences(input: {
  need: GameplayReferenceNeedSpecV1;
  candidates: GameplayReferenceCandidate[];
}): PurposeLabeledGameplayReferenceSet {
  const need = gameplayReferenceNeedSpecV1Schema.parse(input.need);
  const requestedPurposes = [...need.purposes];
  const selected: PurposeLabeledGameplayReference[] = [];
  const reservedIds = new Set<string>();

  if (need.requireCoopDependency && requestedPurposes.includes("coop")) {
    const coopNeed = gameplayReferenceNeedSpecV1Schema.parse({
      ...need,
      purposes: ["coop"],
      maxResults: 1,
      requireCoopDependency: true,
    });
    const coop = retrieveGameplayReferences({ need: coopNeed, candidates: input.candidates })
      .references[0];
    if (coop) {
      selected.push(coop);
      reservedIds.add(coop.reference.referenceId);
    }
  }

  const remainingPurposes = requestedPurposes.filter((purpose) => purpose !== "coop");
  if (remainingPurposes.length && selected.length < need.maxResults) {
    const remainingSlots = need.maxResults - selected.length;
    const broadNeed = gameplayReferenceNeedSpecV1Schema.parse({
      ...need,
      purposes: remainingPurposes,
      maxResults: Math.min(remainingSlots, remainingPurposes.length),
      requireCoopDependency: false,
    });
    const broad = retrieveGameplayReferences({
      need: broadNeed,
      candidates: input.candidates.filter(
        (candidate) => !reservedIds.has(candidate.referenceId),
      ),
    });
    selected.push(...broad.references);
  }

  const byPurpose = new Map(selected.map((item) => [item.purpose, item]));
  return {
    schema: "purpose_labeled_gameplay_reference_set",
    version: 1,
    references: requestedPurposes
      .map((purpose) => byPurpose.get(purpose))
      .filter((item): item is PurposeLabeledGameplayReference => Boolean(item))
      .slice(0, need.maxResults),
  };
}
