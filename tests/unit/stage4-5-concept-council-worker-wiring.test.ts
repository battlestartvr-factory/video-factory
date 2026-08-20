import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workerMain = readFileSync(join(process.cwd(), "worker/main.ts"), "utf8");

describe("Stage 4.5 PR5 Concept Council worker wiring", () => {
  it("constructs the durable repository and deterministic mock designer on the research worker runtime", () => {
    expect(workerMain).toContain('import { MockConceptCouncilDesigner } from "../lib/research-intelligence/concept-council"');
    expect(workerMain).toContain('import { ConceptCouncilRepository } from "../lib/research-intelligence/concept-council-runtime"');
    expect(workerMain).toContain("const conceptCouncil = new ConceptCouncilRepository(rpcClient)");
    expect(workerMain).toContain("conceptCouncil,");
    expect(workerMain).toContain(
      "conceptCouncilDesignerExecutor: config.mockWorkflows ? new MockConceptCouncilDesigner() : null",
    );
  });
});
