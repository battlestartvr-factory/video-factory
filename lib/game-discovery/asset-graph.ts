import { assetGraphV1Schema, type AssetGraphV1 } from "./schemas";
import type { GameplayPrototypeAssembly } from "./assembly";

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

export function attachGameplayPrototypeShort(input: {
  assetGraph: AssetGraphV1;
  assembly: GameplayPrototypeAssembly;
}): AssetGraphV1 {
  if (input.assetGraph.conceptRunId !== input.assembly.conceptRunId) {
    throw new Error("ASSEMBLY_ASSET_GRAPH_CONCEPT_MISMATCH");
  }

  const baseNodes = input.assetGraph.nodes.filter((node) => node.kind !== "short");
  const baseNodeIds = new Set(baseNodes.map((node) => node.id));
  const videoNodeIds = input.assembly.inputVideoGenerationIds.map((generationId) => {
    const node = baseNodes.find(
      (candidate) => candidate.kind === "video" && candidate.generationId === generationId,
    );
    if (!node) throw new Error(`ASSEMBLY_ASSET_GRAPH_VIDEO_MISSING:${generationId}`);
    return node.id;
  });
  const momentNode = baseNodes.find((node) => node.kind === "moment");
  if (!momentNode) throw new Error("ASSEMBLY_ASSET_GRAPH_MOMENT_MISSING");

  const shortNodeId = "prototype-short";
  const edges = input.assetGraph.edges.filter(
    (edge) =>
      baseNodeIds.has(edge.from) &&
      baseNodeIds.has(edge.to) &&
      edge.from !== shortNodeId &&
      edge.to !== shortNodeId,
  );
  for (const videoNodeId of videoNodeIds) {
    edges.push({ from: videoNodeId, to: shortNodeId, relation: "assembles_into" });
  }
  edges.push({ from: shortNodeId, to: momentNode.id, relation: "evidence_for" });

  return assetGraphV1Schema.parse({
    ...input.assetGraph,
    nodes: [
      ...baseNodes,
      {
        id: shortNodeId,
        kind: "short",
        driveFileId: input.assembly.driveFileId,
      },
    ],
    edges,
    metadata: {
      ...(input.assetGraph.metadata ?? {}),
      prototypeAssemblySha256: input.assembly.sha256,
      prototypeDriveFileId: input.assembly.driveFileId,
      prototypeDurationSeconds: input.assembly.durationSeconds,
    },
  });
}
