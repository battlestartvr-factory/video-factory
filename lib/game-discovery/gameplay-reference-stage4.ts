import { z } from "zod";
import { gameplayReferencePurposeSchema } from "./gameplay-reference-schema";
import type { PurposeLabeledGameplayReferenceSet } from "./gameplay-reference-retrieval";

const shortText = z.string().trim().min(1).max(2_000);

export const stage4GameplayReferenceLineageItemSchema = z
  .object({
    referenceId: z.string().trim().min(1).max(160),
    purpose: gameplayReferencePurposeSchema,
    gameId: z.string().trim().min(1).max(160),
    gameName: z.string().trim().min(1).max(240),
    driveFileId: z.string().trim().min(1).max(500),
    score: z.number().min(0).max(1),
    whySelected: z.array(shortText).max(12).default([]),
    gameplayDescription: z.string().trim().min(1).max(4_000),
    whyThisLooksLikeGameplay: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const stage4GameplayReferenceSetSchema = z
  .object({
    schema: z.literal("stage4_gameplay_reference_set"),
    version: z.literal(1),
    references: z.array(stage4GameplayReferenceLineageItemSchema).min(1).max(8),
  })
  .strict();

export const stage4GameplayReferenceProviderAssetSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    url: z.string().trim().url().max(8_000),
    role: gameplayReferencePurposeSchema,
    mimeType: z.string().trim().min(1).max(240),
    filename: z.string().trim().min(1).max(500),
  })
  .strict();

export type Stage4GameplayReferenceLineageItem = z.infer<
  typeof stage4GameplayReferenceLineageItemSchema
>;
export type Stage4GameplayReferenceSet = z.infer<typeof stage4GameplayReferenceSetSchema>;
export type Stage4GameplayReferenceProviderAsset = z.infer<
  typeof stage4GameplayReferenceProviderAssetSchema
>;

export function toStage4GameplayReferenceSet(
  set: PurposeLabeledGameplayReferenceSet,
): Stage4GameplayReferenceSet {
  return stage4GameplayReferenceSetSchema.parse({
    schema: "stage4_gameplay_reference_set",
    version: 1,
    references: set.references.map((item) => ({
      referenceId: item.reference.referenceId,
      purpose: item.purpose,
      gameId: item.reference.gameId,
      gameName: item.reference.gameName,
      driveFileId: item.reference.driveFileId,
      score: item.score,
      whySelected: item.whySelected,
      gameplayDescription: item.reference.gameplayDescription,
      whyThisLooksLikeGameplay: item.reference.whyThisLooksLikeGameplay,
    })),
  });
}

export function gameplayReferenceLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 8) {
    throw new Error("GAMEPLAY_REFERENCE_LABEL_INDEX_INVALID");
  }
  return String.fromCharCode("A".charCodeAt(0) + index);
}

export function gameplayReferencePurposeInstruction(
  item: Stage4GameplayReferenceLineageItem,
): string {
  switch (item.purpose) {
    case "gameplay_camera":
      return "Use only for player-camera grammar: camera attachment, player embodiment, foreground hands/body/tool and teammate distance.";
    case "interaction":
      return "Use only for interaction framing: target distance, affordance placement and the visible input-to-world-response relationship.";
    case "coop":
      return "Use only for co-op readability: how teammate dependency, shared work and coordination remain visible inside a playable frame.";
    case "art_direction":
      return "Use only for art direction: stylization, material simplification, lighting and production-scope feel. Do not inherit its camera grammar.";
  }
}

function clip(value: string, max: number): string {
  const normalized = value.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export function renderGameplayReferenceInstructionBlock(
  input: Stage4GameplayReferenceSet | null | undefined,
): string {
  if (!input?.references.length) return "No external gameplay reference images were selected.";

  const lines = input.references.map((item, index) => {
    const letter = gameplayReferenceLetter(index);
    const reasons = item.whySelected.length
      ? ` Selection reasons: ${clip(item.whySelected.slice(0, 3).join("; "), 220)}.`
      : "";
    return [
      `Reference ${letter} — ${item.purpose.toUpperCase()} — ${item.gameName}.`,
      gameplayReferencePurposeInstruction(item),
      `Gameplay evidence: ${clip(item.gameplayDescription, 360)}`,
      `Why it reads as gameplay: ${clip(item.whyThisLooksLikeGameplay, 240)}${reasons}`,
    ].join("\n");
  });

  return `${lines.join("\n\n")}\n\nREFERENCE FIREWALL:\n- Do not copy game identity, level layout, characters, props, logos, UI branding or the original mechanic.\n- A gameplay-camera reference controls camera grammar only, not art style.\n- An interaction/co-op reference controls readability only, not game identity.\n- An art-direction reference controls stylization only and must never pull the camera into a cinematic or detached composition.`;
}
