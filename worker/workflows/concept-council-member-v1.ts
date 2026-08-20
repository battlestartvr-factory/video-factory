import { DurableWorkflowError } from "../../lib/orchestrator/retry";
import { validateConceptDesignerOutput } from "../../lib/research-intelligence/concept-council";
import type { WorkflowTickHandler } from "./types";

export const conceptCouncilMemberV1: WorkflowTickHandler = async (context) => {
  const repository = context.services?.conceptCouncil;
  if (!repository) {
    throw new DurableWorkflowError({
      code: "CONCEPT_COUNCIL_REPOSITORY_NOT_CONFIGURED",
      message: "Concept Council durable repository is not configured",
      retryable: false,
    });
  }

  const member = await repository.beginMemberJob(context.jobId);

  if (member.existingOutput) {
    return {
      status: "completed",
      currentStage: "concept_council_member_completed",
      progress: 100,
      state: {
        ...context.state,
        research_run_id: member.researchRunId,
        evidence_pack_id: member.evidencePackId,
        designer_role: member.designerRole,
        phase: "completed",
        recovered_from_persisted_output: true,
      },
      result: { concept_designer_output: member.existingOutput },
      stateReason: "concept_designer_output_already_persisted",
      eventType: "concept_council.member.completed",
      eventPayload: {
        research_run_id: member.researchRunId,
        evidence_pack_id: member.evidencePackId,
        designer_role: member.designerRole,
        recovered_from_persisted_output: true,
      },
      creativeRunId: member.creativeRunId,
    };
  }

  const executor = context.services?.conceptCouncilDesignerExecutor;
  if (!executor) {
    throw new DurableWorkflowError({
      code: "CONCEPT_COUNCIL_EXECUTOR_NOT_CONFIGURED",
      message: "Concept Council designer executor is not configured for this worker",
      retryable: false,
      details: {
        research_run_id: member.researchRunId,
        designer_role: member.designerRole,
      },
    });
  }

  const execution = await executor.execute({
    objective: member.objective,
    evidencePack: member.evidencePack,
    designerRole: member.designerRole,
    signal: context.signal,
  });
  const output = validateConceptDesignerOutput(execution.output, member.evidencePack);

  if (
    output.researchRunId !== member.researchRunId ||
    output.evidencePackId !== member.evidencePackId ||
    output.designerRole !== member.designerRole
  ) {
    throw new DurableWorkflowError({
      code: "CONCEPT_COUNCIL_OUTPUT_LINEAGE_MISMATCH",
      message: "Concept Council executor returned output for another durable assignment",
      retryable: false,
    });
  }
  if (output.candidates.length > 4) {
    throw new DurableWorkflowError({
      code: "CONCEPT_COUNCIL_CANDIDATE_BUDGET_EXCEEDED",
      message: "Concept Designer output exceeds the four-candidate hard cap",
      retryable: false,
    });
  }

  const persisted = await repository.persistMemberOutput({
    jobId: context.jobId,
    output,
    provider: execution.provider,
    model: execution.model,
    usage: execution.usage,
  });

  return {
    status: "completed",
    currentStage: "concept_council_member_completed",
    progress: 100,
    state: {
      ...context.state,
      research_run_id: member.researchRunId,
      evidence_pack_id: member.evidencePackId,
      designer_role: member.designerRole,
      phase: "completed",
      candidate_count: persisted.output.candidates.length,
      output_persist_duplicate: persisted.duplicate,
    },
    result: { concept_designer_output: persisted.output },
    stateReason: "concept_council_member_completed",
    eventType: "concept_council.member.completed",
    eventPayload: {
      research_run_id: member.researchRunId,
      evidence_pack_id: member.evidencePackId,
      designer_role: member.designerRole,
      candidate_count: persisted.output.candidates.length,
      output_persist_duplicate: persisted.duplicate,
    },
    creativeRunId: member.creativeRunId,
  };
};
