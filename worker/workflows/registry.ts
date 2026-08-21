import { coreSmokeV1 } from "./core-smoke-v1";
import { externalResearchScoutV1 } from "./external-research-scout-v1";
import { gameDiscoveryBatchStage4InspectedV1 } from "./game-discovery-batch-stage4-inspected-v1";
import { gameDiscoveryBatchV3 } from "./game-discovery-batch-v3";
import {
  conceptCouncilMemberV1Production as conceptCouncilMemberV1,
  gameDiscoveryBatchV2Production,
} from "./stage4-5-production-adapters";
import { GameDiscoveryV3Repository } from "../../lib/research-intelligence/game-discovery-v3";
import type { OrchestratorRpcClient } from "../../lib/orchestrator/rpc";
import { gameplayAuthenticityPlanningSmokeV1 } from "./gameplay-authenticity-planning-smoke-v1";
import { gameplayReferenceIndexV1 } from "./gameplay-reference-index-v1";
import { gameplayReferenceRetrievalSmokeV1 } from "./gameplay-reference-retrieval-smoke-v1";
import { generationImageV1 } from "./generation-image-v1";
import { generationVideoV1 } from "./generation-video-v1";
import type { WorkflowTickContext, WorkflowTickHandler } from "./types";

/**
 * V1/V2 and their repositories remain registered for restart compatibility. V3 reuses
 * the same worker RPC client but deliberately does not reintroduce the old Scout/Council
 * services into its creative graph.
 */
const gameDiscoveryBatchV3Production: WorkflowTickHandler = async (context: WorkflowTickContext) => {
  const services = context.services;
  if (services && !services.gameDiscoveryV3 && services.gameDiscoveryV2) {
    const bridge = services.gameDiscoveryV2 as unknown as { client?: OrchestratorRpcClient };
    if (bridge.client) services.gameDiscoveryV3 = new GameDiscoveryV3Repository(bridge.client);
  }
  return gameDiscoveryBatchV3(context);
};

const registry = new Map<string, WorkflowTickHandler>([
  ["concept_council_member@1", conceptCouncilMemberV1],
  ["core_smoke@1", coreSmokeV1],
  ["external_research_scout@1", externalResearchScoutV1],
  ["game_discovery_batch@1", gameDiscoveryBatchStage4InspectedV1],
  ["game_discovery_batch@2", gameDiscoveryBatchV2Production],
  ["game_discovery_batch@3", gameDiscoveryBatchV3Production],
  ["gameplay_authenticity_planning_smoke@1", gameplayAuthenticityPlanningSmokeV1],
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