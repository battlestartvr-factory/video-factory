import { assetGraphV1Schema, type AssetGraphV1 } from "./schemas";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstDriveFileId(outputs: Array<Record<string, unknown>>): string | undefined {
  for (const output of outputs) {
    const row = object(output);
    const value = text(row.driveFileId) ?? text(row.drive_file_id);
    if (value) return value;
  }
  return undefined;
}

export interface BuildGameplayAssetGraphInput {
  objectiveRunId: string;
  conceptRunId: string;
  conceptId: string;
  momentId: string;
  shotId: string;
  approvedReferenceGenerationId: string;
  approvedReferenceOutputs: Array<Record<string, unknown>>;
  videoGenerationId: string;
  videoOutputs: Array<Record<string, unknown>>;
}

export function buildGameplayAssetGraph(input: BuildGameplayAssetGraphInput): AssetGraphV1 {
  const imageDriveFileId = firstDriveFileId(input.approvedReferenceOutputs);
  const videoDriveFileId = firstDriveFileId(input.videoOutputs);

  return assetGraphV1Schema.parse({
    schema: "asset_graph",
    version: 1,
    objectiveRunId: input.objectiveRunId,
    conceptRunId: input.conceptRunId,
    nodes: [
      {
        id: "concept",
        kind: "concept",
        creativeRunId: input.conceptRunId,
      },
      {
        id: "moment",
        kind: "moment",
        creativeRunId: input.conceptRunId,
      },
      {
        id: "shot",
        kind: "shot",
        creativeRunId: input.conceptRunId,
      },
      {
        id: "reference-image",
        kind: "image",
        generationId: input.approvedReferenceGenerationId,
        ...(imageDriveFileId ? { driveFileId: imageDriveFileId } : {}),
      },
      {
        id: "gameplay-video",
        kind: "video",
        generationId: input.videoGenerationId,
        ...(videoDriveFileId ? { driveFileId: videoDriveFileId } : {}),
      },
    ],
    edges: [
      { from: "concept", to: "moment", relation: "plans" },
      { from: "moment", to: "shot", relation: "plans" },
      { from: "shot", to: "reference-image", relation: "plans" },
      { from: "reference-image", to: "gameplay-video", relation: "keyframe_for" },
      { from: "gameplay-video", to: "moment", relation: "evidence_for" },
    ],
    metadata: {
      source: "stage4_gameplay_prototype_v1",
      conceptId: input.conceptId,
      momentId: input.momentId,
      shotId: input.shotId,
      approvedReferenceGenerationId: input.approvedReferenceGenerationId,
      videoGenerationId: input.videoGenerationId,
    },
  });
}
