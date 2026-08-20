import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ResearchScoutExecutor,
  ResearchScoutJobContext,
  ResearchScoutRepository,
} from "@/lib/research-intelligence/scout-runtime";
import type {
  ResearchScoutAssignmentSpecV1,
  ResearchScoutReportSpecV1,
  ResearchScoutRoleV1,
} from "@/lib/research-intelligence/schemas";
import { externalResearchScoutV1 } from "@/worker/workflows/external-research-scout-v1";
import type { WorkflowServices, WorkflowTickContext } from "@/worker/workflows/types";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260820133500_stage4_5_research_scout_orchestration.sql"),
  "utf8",
);
const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
const workerMain = readFileSync(join(process.cwd(), "worker/main.ts"), "utf8");
const registry = readFileSync(join(process.cwd(), "worker/workflows/registry.ts"), "utf8");

const roles: ResearchScoutRoleV1[] = [
  "market_competitor",
  "mechanics",
  "player_voice",
  "gameplay_visual",
  "white_space_contrarian",
];

function assignment(role: ResearchScoutRoleV1): ResearchScoutAssignmentSpecV1 {
  return {
    role,
    mandate: `Study ${role} without overlapping other Scouts.`,
    queryAngles: [`${role} query`],
    freshness: "mixed",
    sourcePreferences: [],
    forbiddenOverlap: [],
    imageSearchRequired: role === "gameplay_visual",
    budget: {
      maxSearchQueries: 2,
      maxFetchedSources: 4,
      maxEvidenceItems: 5,
      maxImageCandidates: role === "gameplay_visual" ? 4 : 0,
      maxModelCalls: 1,
    },
  };
}

function scoutContext(role: ResearchScoutRoleV1, existingReport: ResearchScoutReportSpecV1 | null = null): ResearchScoutJobContext {
  return {
    researchRunId: "research-run-1",
    scoutRole: role,
    assignment: assignment(role),
    creativeRunId: `creative-${role}`,
    rootFactoryJobId: "root-job-1",
    rootCreativeRunId: "root-creative-1",
    objectiveId: "objective-1",
    existingReport,
  };
}

function report(role: ResearchScoutRoleV1, queriesExecuted = 1): ResearchScoutReportSpecV1 {
  return {
    schema: "research_scout_report",
    version: 1,
    researchRunId: "research-run-1",
    scoutRole: role,
    summary: `Completed ${role} research.`,
    sourceIds: [],
    evidenceIds: [],
    imageCandidateIds: [],
    queriesExecuted,
    coverageNotes: [],
    warnings: [],
    generatedAt: "2026-08-20T12:00:00.000Z",
  };
}

function tickContext(jobId: string, services: WorkflowServices): WorkflowTickContext {
  return {
    jobId,
    workflowKind: "external_research_scout",
    workflowVersion: 1,
    currentStage: "research_scout_assigned",
    state: {},
    retryCount: 0,
    signal: new AbortController().signal,
    services,
  };
}

describe("Stage 4.5 PR3 durable Research Scout DB contract", () => {
  it("uses a dedicated logged research queue and keeps factory_jobs authoritative", () => {
    expect(migration).toContain("pgmq.create('research_orchestrator_v1')");
    expect(migration).not.toContain("create_unlogged('research_orchestrator_v1')");
    expect(migration).toContain("external_research_scout");
    expect(migration).toContain("factory_job_id UUID NOT NULL UNIQUE REFERENCES public.factory_jobs");
    expect(migration).toContain("PRIMARY KEY (run_id, scout_role)");
  });

  it("fans out exactly the five canonical roles and serializes duplicate fan-out", () => {
    expect(migration).toMatch(/v_count <> 5 OR v_distinct_count <> 5/);
    for (const role of roles) expect(migration).toContain(`'${role}'`);
    expect(migration).toMatch(/FROM public\.research_runs AS rr[\s\S]*?FOR UPDATE/);
    expect(migration).toMatch(/WHERE rsa\.run_id = v_research_run_id[\s\S]*?rsa\.scout_role = v_role/);
    expect(migration).toContain("'duplicate', true");
  });

  it("routes Scout wakes, heartbeats, retries and watchdog recovery to the research queue", () => {
    expect(migration).toMatch(/orchestrator_queue_name_for_workflow/);
    expect(migration).toMatch(/WHEN p_workflow_kind IN \('external_research_scout', 'concept_council_member'\)/);
    expect(migration).toMatch(/pgmq\.send\(\s*'research_orchestrator_v1'/);
    expect(migration).toMatch(/v_queue_name := public\.orchestrator_queue_name_for_workflow/);
    expect(migration).toMatch(/pgmq\.set_vt\(v_queue_name/);
    expect(migration).toMatch(/FROM pgmq\.send\(\s*v_queue_name/);
  });

  it("persists a Scout report before job completion so restart can skip paid/tool work", () => {
    expect(migration).toContain("research_begin_scout_job");
    expect(migration).toContain("existing_report");
    expect(migration).toContain("research_persist_scout_report");
    expect(migration).toMatch(/v_existing := v_row\.outputs->'scout_report'/);
    expect(migration).toMatch(/outputs = jsonb_set\([\s\S]*?'\{scout_report\}'[\s\S]*?v_report[\s\S]*?true\)/);
  });
});

describe("Stage 4.5 PR3 worker isolation and concurrency", () => {
  it("keeps the media/core worker at concurrency one and gives research a five-job pool", () => {
    const coreWorker = compose.match(/\n  worker:[\s\S]*?\n  research-worker:/)?.[0] ?? "";
    const researchWorker = compose.match(/\n  research-worker:[\s\S]*?\n  caddy:/)?.[0] ?? "";
    expect(coreWorker).toContain("ORCHESTRATOR_QUEUE_MODE: core");
    expect(coreWorker).toContain('WORKER_CONCURRENCY: "1"');
    expect(researchWorker).toContain("ORCHESTRATOR_QUEUE_MODE: research");
    expect(researchWorker).toContain('WORKER_CONCURRENCY: "5"');
  });

  it("uses concurrency across independent queue deliveries rather than one root Scout Promise.all", () => {
    expect(workerMain).toContain("quantity: config.workerConcurrency");
    expect(workerMain).toContain("Promise.all(deliveries.map((delivery) => processDelivery(delivery)))");
    expect(workerMain).not.toContain("Promise.all(scout");
  });

  it("registers external_research_scout@1 without replacing game_discovery_batch@1", () => {
    expect(registry).toContain('["external_research_scout@1", externalResearchScoutV1]');
    expect(registry).toContain('["game_discovery_batch@1", gameDiscoveryBatchStage4InspectedV1]');
  });
});

describe("Stage 4.5 PR3 Scout workflow restart and independent completion", () => {
  it("completes five mocked Scout jobs independently", async () => {
    const executed = vi.fn<(jobId: string) => void>();
    const persisted = vi.fn<(jobId: string) => void>();

    const repository = {
      async beginScoutJob(jobId: string) {
        const role = roles.find((candidate) => jobId === `job-${candidate}`);
        if (!role) throw new Error("unknown job");
        return scoutContext(role);
      },
      async persistScoutReport(input: { jobId: string; report: ResearchScoutReportSpecV1 }) {
        persisted(input.jobId);
        return { duplicate: false, report: input.report };
      },
    } as unknown as ResearchScoutRepository;

    const executor = {
      async execute(input: Parameters<ResearchScoutExecutor["execute"]>[0]) {
        executed(input.jobId);
        return { report: report(input.context.scoutRole), provider: "mock", model: "mock" };
      },
    } satisfies ResearchScoutExecutor;

    const services = { researchScouts: repository, researchScoutExecutor: executor } as unknown as WorkflowServices;
    const outcomes = await Promise.all(
      roles.map((role) => externalResearchScoutV1(tickContext(`job-${role}`, services))),
    );

    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome.status === "completed")).toBe(true);
    expect(new Set(outcomes.map((outcome) => outcome.creativeRunId)).size).toBe(5);
    expect(executed).toHaveBeenCalledTimes(5);
    expect(persisted).toHaveBeenCalledTimes(5);
  });

  it("does not re-run the executor after a typed report was already persisted before a crash", async () => {
    const existing = report("mechanics");
    const repository = {
      beginScoutJob: vi.fn().mockResolvedValue(scoutContext("mechanics", existing)),
      persistScoutReport: vi.fn(),
    } as unknown as ResearchScoutRepository;
    const executor: ResearchScoutExecutor = { execute: vi.fn() };
    const services = { researchScouts: repository, researchScoutExecutor: executor } as unknown as WorkflowServices;

    const outcome = await externalResearchScoutV1(tickContext("job-mechanics", services));

    expect(outcome.status).toBe("completed");
    expect(outcome.state).toMatchObject({ recovered_from_persisted_report: true });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(repository.persistScoutReport).not.toHaveBeenCalled();
  });

  it("fails closed when a Scout output exceeds its durable query budget", async () => {
    const repository = {
      beginScoutJob: vi.fn().mockResolvedValue(scoutContext("player_voice")),
      persistScoutReport: vi.fn(),
    } as unknown as ResearchScoutRepository;
    const executor: ResearchScoutExecutor = {
      execute: vi.fn().mockResolvedValue({ report: report("player_voice", 3) }),
    };
    const services = { researchScouts: repository, researchScoutExecutor: executor } as unknown as WorkflowServices;

    await expect(externalResearchScoutV1(tickContext("job-player_voice", services))).rejects.toMatchObject({
      code: "RESEARCH_SCOUT_QUERY_BUDGET_EXCEEDED",
      retryable: false,
    });
    expect(repository.persistScoutReport).not.toHaveBeenCalled();
  });
});
