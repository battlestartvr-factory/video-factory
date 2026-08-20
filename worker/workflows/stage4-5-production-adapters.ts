import {
  InternalKieConceptCurator,
  InternalKieConceptDesigner,
  InternalKieResearchSynthesizer,
} from "../../lib/research-intelligence/kie-intelligence-client";
import { conceptCouncilMemberV1 } from "./concept-council-member-v1";
import { gameDiscoveryBatchV2 } from "./game-discovery-batch-v2";
import type { WorkflowTickContext, WorkflowTickHandler } from "./types";

function serviceRoleKey(): string {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();
}

function kieConfigured(): boolean {
  return Boolean((process.env.KIE_API_KEY ?? process.env.AGENT_LLM_API_KEY ?? "").trim());
}

function attachProductionIntelligence(context: WorkflowTickContext): void {
  const services = context.services;
  if (!services || !kieConfigured()) return;
  const key = serviceRoleKey();
  if (!key) return;

  services.researchSynthesizerExecutor ??= new InternalKieResearchSynthesizer(key);
  services.conceptCouncilDesignerExecutor ??= new InternalKieConceptDesigner(key);
  services.conceptCouncilCuratorExecutor ??= new InternalKieConceptCurator(key);
}

export const gameDiscoveryBatchV2Production: WorkflowTickHandler = async (context) => {
  attachProductionIntelligence(context);
  return gameDiscoveryBatchV2(context);
};

export const conceptCouncilMemberV1Production: WorkflowTickHandler = async (context) => {
  attachProductionIntelligence(context);
  return conceptCouncilMemberV1(context);
};
