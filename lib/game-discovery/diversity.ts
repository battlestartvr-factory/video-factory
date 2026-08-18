import type { CoopGameConceptSpecV1 } from "./schemas";

export const DIVERSITY_AXES = [
  "dependency_type",
  "social_tension",
  "tempo",
  "camera_scale",
  "failure_signature",
  "buildability_shape",
] as const;

export type DiversityAxis = (typeof DIVERSITY_AXES)[number];

export interface ConceptDiversitySignature {
  coreMechanic: string;
  dependencyType: string;
  socialTension: string;
  tempo: string;
  cameraScale: string;
  failureSignature: string;
  buildabilityShape: string;
}

export interface DiversityComparison {
  candidateConceptId: string;
  referenceConceptId: string;
  axisDistance: number;
  matchingAxes: DiversityAxis[];
  differingAxes: DiversityAxis[];
  hardDuplicate: boolean;
  softNearDuplicate: boolean;
  reasons: string[];
}

export interface DiversityAssessment {
  decision: "accept" | "replace";
  nearest: DiversityComparison | null;
  comparisons: DiversityComparison[];
  rejectionReasons: string[];
  underexploredAxes: DiversityAxis[];
}

const axisAliases: Record<DiversityAxis, string[]> = {
  dependency_type: ["dependency", "dependency_type", "coop_dependency", "co-op dependency"],
  social_tension: ["social", "social_tension", "tension", "social tension"],
  tempo: ["tempo", "pace", "pacing"],
  camera_scale: ["camera", "scale", "camera_scale", "camera/scale", "camera scale"],
  failure_signature: ["failure", "failure_signature", "failure mode", "failure signature"],
  buildability_shape: ["buildability", "buildability_shape", "scope", "buildability shape"],
};

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function noveltyChoice(concept: CoopGameConceptSpecV1, axis: DiversityAxis): string | null {
  const aliases = new Set(axisAliases[axis].map(normalize));
  for (const noveltyAxis of concept.noveltyAxes) {
    if (aliases.has(normalize(noveltyAxis.axis))) return normalize(noveltyAxis.choice);
  }
  return null;
}

function buildabilityShape(concept: CoopGameConceptSpecV1): string {
  const buildability = concept.buildability;
  return [
    buildability.networking,
    buildability.physics,
    buildability.contentBurden,
    buildability.npcAiDependency,
    buildability.systemicInteractions,
  ].join("|");
}

export function conceptDiversitySignature(
  concept: CoopGameConceptSpecV1,
): ConceptDiversitySignature {
  return {
    coreMechanic: normalize(concept.coreMechanic),
    dependencyType: noveltyChoice(concept, "dependency_type") ?? normalize(concept.coopDependency),
    socialTension: noveltyChoice(concept, "social_tension") ?? normalize(concept.socialMoment),
    tempo: noveltyChoice(concept, "tempo") ?? "unspecified",
    cameraScale: noveltyChoice(concept, "camera_scale") ?? normalize(concept.camera),
    failureSignature: noveltyChoice(concept, "failure_signature") ?? normalize(concept.failureMode),
    buildabilityShape:
      noveltyChoice(concept, "buildability_shape") ?? buildabilityShape(concept),
  };
}

function axisValue(signature: ConceptDiversitySignature, axis: DiversityAxis): string {
  switch (axis) {
    case "dependency_type":
      return signature.dependencyType;
    case "social_tension":
      return signature.socialTension;
    case "tempo":
      return signature.tempo;
    case "camera_scale":
      return signature.cameraScale;
    case "failure_signature":
      return signature.failureSignature;
    case "buildability_shape":
      return signature.buildabilityShape;
  }
}

export function compareConceptDiversity(
  candidate: CoopGameConceptSpecV1,
  reference: CoopGameConceptSpecV1,
): DiversityComparison {
  const candidateSignature = conceptDiversitySignature(candidate);
  const referenceSignature = conceptDiversitySignature(reference);
  const matchingAxes: DiversityAxis[] = [];
  const differingAxes: DiversityAxis[] = [];

  for (const axis of DIVERSITY_AXES) {
    if (axisValue(candidateSignature, axis) === axisValue(referenceSignature, axis)) {
      matchingAxes.push(axis);
    } else {
      differingAxes.push(axis);
    }
  }

  const sameCoreAndDependency =
    candidateSignature.coreMechanic === referenceSignature.coreMechanic &&
    candidateSignature.dependencyType === referenceSignature.dependencyType;
  const sameDependencySocialFailure =
    candidateSignature.dependencyType === referenceSignature.dependencyType &&
    candidateSignature.socialTension === referenceSignature.socialTension &&
    candidateSignature.failureSignature === referenceSignature.failureSignature;
  const tooFewDifferentAxes = differingAxes.length < 2;

  const reasons: string[] = [];
  if (sameCoreAndDependency) reasons.push("same_core_mechanic_and_dependency");
  if (sameDependencySocialFailure) reasons.push("same_dependency_social_failure_triple");
  if (tooFewDifferentAxes) reasons.push("fewer_than_two_different_novelty_axes");

  const hardDuplicate = reasons.length > 0;
  const softNearDuplicate = !hardDuplicate && differingAxes.length <= 2;
  if (softNearDuplicate) reasons.push("low_axis_distance");

  return {
    candidateConceptId: candidate.conceptId,
    referenceConceptId: reference.conceptId,
    axisDistance: differingAxes.length,
    matchingAxes,
    differingAxes,
    hardDuplicate,
    softNearDuplicate,
    reasons,
  };
}

export function assessConceptDiversity(
  candidate: CoopGameConceptSpecV1,
  references: CoopGameConceptSpecV1[],
): DiversityAssessment {
  if (references.length === 0) {
    return {
      decision: "accept",
      nearest: null,
      comparisons: [],
      rejectionReasons: [],
      underexploredAxes: [...DIVERSITY_AXES],
    };
  }

  const comparisons = references.map((reference) => compareConceptDiversity(candidate, reference));
  comparisons.sort(
    (left, right) =>
      left.axisDistance - right.axisDistance ||
      left.referenceConceptId.localeCompare(right.referenceConceptId),
  );
  const nearest = comparisons[0] ?? null;
  const hardDuplicate = comparisons.find((comparison) => comparison.hardDuplicate);
  const replacementComparison = hardDuplicate ?? (nearest?.softNearDuplicate ? nearest : null);

  if (!replacementComparison) {
    return {
      decision: "accept",
      nearest,
      comparisons,
      rejectionReasons: [],
      underexploredAxes: nearest?.differingAxes ?? [...DIVERSITY_AXES],
    };
  }

  return {
    decision: "replace",
    nearest,
    comparisons,
    rejectionReasons: replacementComparison.reasons.map(
      (reason) => `${reason}:${replacementComparison.referenceConceptId}`,
    ),
    underexploredAxes: replacementComparison.matchingAxes,
  };
}
