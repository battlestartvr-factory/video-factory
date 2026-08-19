import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { GameplayReferenceCaptionOutputError } from "./gameplay-reference-captioner";

export function isGameplayReferenceCaptionOutputError(
  error: unknown,
): error is GameplayReferenceCaptionOutputError {
  return error instanceof GameplayReferenceCaptionOutputError;
}

export async function persistGameplayReferenceCaptionFailureEvidence(input: {
  referenceId: string;
  error: GameplayReferenceCaptionOutputError;
}): Promise<void> {
  const supabase = createSupabaseServiceClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("gameplay_references")
    .update({
      index_status: "failed",
      index_error: input.error.code,
      caption_model: input.error.model,
      caption_usage: {
        ...input.error.usage,
        modelCalls: 1,
        schemaRepairModelCalls: 0,
        normalization: "deterministic",
        outcome: "failed_schema_validation",
      },
      caption_debug: {
        rawResponse: input.error.rawResponse,
        validationError: input.error.validationError,
      },
      updated_at: now,
    })
    .eq("reference_id", input.referenceId);
  if (error) {
    throw new Error(`GAMEPLAY_REFERENCE_CAPTION_FAILURE_EVIDENCE_WRITE_FAILED:${error.message}`);
  }
}
