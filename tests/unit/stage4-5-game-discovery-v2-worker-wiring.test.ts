import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workerMain = readFileSync(join(process.cwd(), "worker/main.ts"), "utf8");
const workflowTypes = readFileSync(join(process.cwd(), "worker/workflows/types.ts"), "utf8");

describe("Stage 4.5 PR7 worker wiring", () => {
  it("wires Research Memory, synthesis, Concept Curator and v2 root repository", () => {
    expect(workerMain).toContain('import { GameDiscoveryV2Repository } from "../lib/research-intelligence/game-discovery-v2"');
    expect(workerMain).toContain('import { ResearchIntelligenceRepository } from "../lib/research-intelligence/repository"');
    expect(workerMain).toContain('import { MockResearchSynthesizer } from "../lib/research-intelligence/synthesis"');
    expect(workerMain).toContain('import { MockConceptCouncilCurator } from "../lib/research-intelligence/concept-curator"');
    expect(workerMain).toContain("gameDiscoveryV2: new GameDiscoveryV2Repository(rpcClient)");
    expect(workerMain).toContain("const researchIntelligence = new ResearchIntelligenceRepository(rpcClient)");
    expect(workerMain).toContain("researchSynthesizerExecutor: config.mockWorkflows ? new MockResearchSynthesizer() : null");
    expect(workerMain).toContain("conceptCouncilCuratorExecutor: config.mockWorkflows ? new MockConceptCouncilCurator() : null");
  });

  it("keeps paid/non-mock research and council execution fail-closed until real executors are explicitly configured", () => {
    expect(workerMain).toContain("researchScoutExecutor: config.mockWorkflows ? new MockResearchScoutExecutor() : null");
    expect(workerMain).toContain("conceptCouncilDesignerExecutor: config.mockWorkflows ? new MockConceptCouncilDesigner() : null");
    expect(workflowTypes).toContain("researchSynthesizerExecutor?: ResearchSynthesizerExecutor | null");
    expect(workflowTypes).toContain("conceptCouncilCuratorExecutor?: ConceptCouncilCuratorExecutor | null");
  });
});
