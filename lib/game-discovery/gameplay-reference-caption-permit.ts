import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export interface GameplayReferenceCaptionPermitClaim {
  claimed: boolean;
  referenceId: string;
  status: string | null;
  attemptId: string | null;
  existingAttemptId: string | null;
  startedAt: string | null;
  reason: string | null;
}

export function parseGameplayReferenceCaptionPermitClaim(
  raw: unknown,
): GameplayReferenceCaptionPermitClaim {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    claimed: value.claimed === true,
    referenceId: typeof value.reference_id === "string" ? value.reference_id : "",
    status: typeof value.status === "string" ? value.status : null,
    attemptId: typeof value.attempt_id === "string" ? value.attempt_id : null,
    existingAttemptId:
      typeof value.existing_attempt_id === "string" ? value.existing_attempt_id : null,
    startedAt: typeof value.started_at === "string" ? value.started_at : null,
    reason: typeof value.reason === "string" ? value.reason : null,
  };
}

export async function claimGameplayReferenceCaptionAttempt(
  referenceId: string,
): Promise<GameplayReferenceCaptionPermitClaim> {
  const attemptId = crypto.randomUUID();
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase.rpc("gameplay_reference_claim_caption_attempt_v1", {
    p_reference_id: referenceId,
    p_attempt_id: attemptId,
  });
  if (error) {
    throw new Error(`GAMEPLAY_REFERENCE_CAPTION_PERMIT_RPC_FAILED:${error.message}`);
  }

  const claim = parseGameplayReferenceCaptionPermitClaim(data);
  if (!claim.claimed) {
    const detail = [claim.status, claim.reason, claim.existingAttemptId]
      .filter((value): value is string => Boolean(value))
      .join(":");
    throw new Error(
      `GAMEPLAY_REFERENCE_CAPTION_PERMIT_DENIED:${detail || claim.referenceId || referenceId}`,
    );
  }
  if (!claim.attemptId || claim.attemptId !== attemptId) {
    throw new Error("GAMEPLAY_REFERENCE_CAPTION_PERMIT_INVALID_RESPONSE");
  }
  return claim;
}
