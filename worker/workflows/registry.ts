import { coreSmokeV1 } from "./core-smoke-v1";
import { gameDiscoveryBatchStage4InspectedV1 } from "./game-discovery-batch-stage4-inspected-v1";
import { gameplayReferenceIndexV1 } from "./gameplay-reference-index-v1";
import { gameplayReferenceRetrievalSmokeV1 } from "./gameplay-reference-retrieval-smoke-v1";
import { generationImageV1 } from "./generation-image-v1";
import { generationVideoV1 } from "./generation-video-v1";
import type { WorkflowTickHandler } from "./types";

const registry = new Map<string, WorkflowTickHandler>([
  ["core_smoke@1", coreSmokeV1],
  ["game_discovery_batch@1", gameDiscoveryBatchStage4InspectedV1],
  ["gameplay_reference_index@1", gameplayReferenceIndexV1],
  ["gameplay_reference_retrieval_smoke@1", gameplayReferenceRetrievalSmokeV1],
  ["generation_image@1", generationImageV1],
  ["generation_video@1", generationVideoV1],
]);

export function workflowRegistryKey(kind: string, version: number): string {
  return `${kind}@${version}`;
}

export function getWorkflowHandler(kind: string, version: number): WorkflowTickHandler | null {
  return registry.get(workflowRegistryKey(kind, version)) ?? null;
}

export function listRegisteredWorkflows(): string[] {
  return [...registry.keys()].sort();
}
