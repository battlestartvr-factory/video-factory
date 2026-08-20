import { DurableWorkflowError } from "../orchestrator/retry";
import { requireRpcObject, type OrchestratorRpcClient } from "../orchestrator/rpc";
import {
  researchPlanSpecV1Schema,
  researchScoutAssignmentSpecV1Schema,
  researchScoutReportSpecV1Schema,
  type ResearchPlanSpecV1,
  type ResearchScoutAssignmentSpecV1,
  type ResearchScoutReportSpecV1,
  type ResearchScoutRoleV1,
} from "./schemas";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ResearchScoutChild {
  scoutRole: ResearchScoutRoleV1;
  factoryJobId: string;
  creativeRunId: string;
  duplicate: boolean;
  queueMsgId: number | null;
}

export interface ResearchScoutFanout {
  researchRunId: string;
  status: "waiting_scouts";
  scouts: ResearchScoutChild[];
}

export interface ResearchScoutJobContext {
  researchRunId: string;
  scoutRole: ResearchScoutRoleV1;
  assignment: ResearchScoutAssignmentSpecV1;
  creativeRunId: string;
  rootFactoryJobId: string;
  rootCreativeRunId: string;
  objectiveId: string;
  existingReport: ResearchScoutReportSpecV1 | null;
}

export interface ResearchScoutExecutionResult {
  report: ResearchScoutReportSpecV1;
  usage?: Record<string, unknown>;
  model?: string | null;
  provider?: string | null;
}

export interface ResearchScoutExecutor {
  execute(input: {
    jobId: string;
    context: ResearchScoutJobContext;
    signal: AbortSignal;
  }): Promise<ResearchScoutExecutionResult>;
}

export interface ResearchScoutFanoutItem {
  scoutRole: ResearchScoutRoleV1;
  factoryJobId: string;
  creativeRunId: string;
  jobStatus: string;
  retryCount: number;
  error: Record<string, unknown> | null;
  report: ResearchScoutReportSpecV1 | null;
}

export interface ResearchScoutFanoutStatus {
  researchRunId: string;
  scoutCount: number;
  terminalCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  allTerminal: boolean;
  items: ResearchScoutFanoutItem[];
}

function parseChild(value: unknown): ResearchScoutChild | null {
  const row = object(value);
  const role = row.scout_role;
  const factoryJobId = text(row.factory_job_id);
  const creativeRunId = text(row.creative_run_id);
  const parsedRole = typeof role === "string" ? role : "";
  if (!factoryJobId || !creativeRunId) return null;
  if (![
    "market_competitor",
    "mechanics",
    "player_voice",
    "gameplay_visual",
    "white_space_contrarian",
  ].includes(parsedRole)) {
    return null;
  }
  return {
    scoutRole: parsedRole as ResearchScoutRoleV1,
    factoryJobId,
    creativeRunId,
    duplicate: row.duplicate === true,
    queueMsgId: typeof row.queue_msg_id === "number" ? row.queue_msg_id : null,
  };
}

function parseReport(value: unknown): ResearchScoutReportSpecV1 | null {
  if (value === null || value === undefined) return null;
  const parsed = researchScoutReportSpecV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class ResearchScoutRepository {
  constructor(private readonly client: OrchestratorRpcClient) {}

  async fanOut(plan: ResearchPlanSpecV1): Promise<ResearchScoutFanout> {
    const parsedPlan = researchPlanSpecV1Schema.parse(plan);
    const { data, error } = await this.client.rpc("research_director_fanout", {
      payload: {
        research_run_id: parsedPlan.researchRunId,
        plan: parsedPlan,
      },
    });
    if (error) {
      throw new DurableWorkflowError({
        code: "RESEARCH_DIRECTOR_FANOUT_FAILED",
        message: `Failed to create research Scout fan-out: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "research_director_fanout");
    const researchRunId = text(row.research_run_id);
    const scouts = array(row.scouts).map(parseChild).filter((item): item is ResearchScoutChild => item !== null);
    if (!researchRunId || row.status !== "waiting_scouts" || scouts.length !== 5) {
      throw new DurableWorkflowError({
        code: "RESEARCH_DIRECTOR_FANOUT_INVALID",
        message: "Research Director returned an invalid five-Scout fan-out",
        retryable: false,
      });
    }
    return { researchRunId, status: "waiting_scouts", scouts };
  }

  async beginScoutJob(jobId: string): Promise<ResearchScoutJobContext> {
    const { data, error } = await this.client.rpc("research_begin_scout_job", { p_job_id: jobId });
    if (error) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_CONTEXT_FAILED",
        message: `Failed to load research Scout context: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "research_begin_scout_job");
    const researchRunId = text(row.research_run_id);
    const creativeRunId = text(row.creative_run_id);
    const rootFactoryJobId = text(row.root_factory_job_id);
    const rootCreativeRunId = text(row.root_creative_run_id);
    const objectiveId = text(row.objective_id);
    const assignment = researchScoutAssignmentSpecV1Schema.safeParse(row.assignment);
    if (!researchRunId || !creativeRunId || !rootFactoryJobId || !rootCreativeRunId || !objectiveId || !assignment.success) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_CONTEXT_INVALID",
        message: "Durable research Scout context is invalid",
        retryable: false,
      });
    }
    const scoutRole = assignment.data.role;
    if (row.scout_role !== scoutRole) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_ROLE_MISMATCH",
        message: "Scout assignment role does not match durable fan-out role",
        retryable: false,
      });
    }
    const existingReport = parseReport(row.existing_report);
    if (row.existing_report != null && !existingReport) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_STORED_REPORT_INVALID",
        message: "Stored research Scout report does not match the v1 schema",
        retryable: false,
      });
    }
    return {
      researchRunId,
      scoutRole,
      assignment: assignment.data,
      creativeRunId,
      rootFactoryJobId,
      rootCreativeRunId,
      objectiveId,
      existingReport,
    };
  }

  async persistScoutReport(input: {
    jobId: string;
    report: ResearchScoutReportSpecV1;
    usage?: Record<string, unknown>;
    model?: string | null;
    provider?: string | null;
  }): Promise<{ duplicate: boolean; report: ResearchScoutReportSpecV1 }> {
    const report = researchScoutReportSpecV1Schema.parse(input.report);
    const { data, error } = await this.client.rpc("research_persist_scout_report", {
      payload: {
        job_id: input.jobId,
        report,
        usage: input.usage ?? {},
        model: input.model ?? null,
        provider: input.provider ?? null,
      },
    });
    if (error) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_REPORT_PERSIST_FAILED",
        message: `Failed to persist research Scout report: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "research_persist_scout_report");
    const stored = researchScoutReportSpecV1Schema.safeParse(row.report);
    if (row.persisted !== true || !stored.success) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_REPORT_PERSIST_INVALID",
        message: "Persisted research Scout report response is invalid",
        retryable: false,
      });
    }
    return { duplicate: row.duplicate === true, report: stored.data };
  }

  async getFanoutStatus(researchRunId: string): Promise<ResearchScoutFanoutStatus> {
    const { data, error } = await this.client.rpc("research_get_scout_fanout_status", {
      p_research_run_id: researchRunId,
    });
    if (error) {
      throw new DurableWorkflowError({
        code: "RESEARCH_SCOUT_FANOUT_STATUS_FAILED",
        message: `Failed to inspect research Scout fan-out: ${error.message}`,
        retryable: true,
      });
    }
    const row = requireRpcObject(data, "research_get_scout_fanout_status");
    const id = text(row.research_run_id);
    if (!id) throw new Error("Invalid research Scout fan-out status response");
    const items = array(row.items).map((value) => {
      const item = object(value);
      const role = text(item.scout_role) as ResearchScoutRoleV1 | null;
      const factoryJobId = text(item.factory_job_id);
      const creativeRunId = text(item.creative_run_id);
      const jobStatus = text(item.job_status);
      if (!role || !factoryJobId || !creativeRunId || !jobStatus) return null;
      return {
        scoutRole: role,
        factoryJobId,
        creativeRunId,
        jobStatus,
        retryCount: typeof item.retry_count === "number" ? item.retry_count : 0,
        error: item.error && typeof item.error === "object" && !Array.isArray(item.error)
          ? (item.error as Record<string, unknown>)
          : null,
        report: parseReport(item.report),
      } satisfies ResearchScoutFanoutItem;
    }).filter((item): item is ResearchScoutFanoutItem => item !== null);
    return {
      researchRunId: id,
      scoutCount: typeof row.scout_count === "number" ? row.scout_count : items.length,
      terminalCount: typeof row.terminal_count === "number" ? row.terminal_count : 0,
      completedCount: typeof row.completed_count === "number" ? row.completed_count : 0,
      failedCount: typeof row.failed_count === "number" ? row.failed_count : 0,
      cancelledCount: typeof row.cancelled_count === "number" ? row.cancelled_count : 0,
      allTerminal: row.all_terminal === true,
      items,
    };
  }
}

export class ResearchDirector {
  constructor(private readonly repository: Pick<ResearchScoutRepository, "fanOut">) {}

  async fanOut(plan: ResearchPlanSpecV1): Promise<ResearchScoutFanout> {
    return this.repository.fanOut(researchPlanSpecV1Schema.parse(plan));
  }
}
