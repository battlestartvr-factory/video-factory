import { describe, expect, it } from "vitest";
import { parseGameplayReferenceCaptionPermitClaim } from "../../lib/game-discovery/gameplay-reference-caption-permit";

describe("gameplay reference caption single-call permit", () => {
  it("parses the durable owner identity from a successful atomic claim", () => {
    expect(
      parseGameplayReferenceCaptionPermitClaim({
        claimed: true,
        reference_id: "gref-test",
        status: "captioning",
        attempt_id: "11111111-1111-4111-8111-111111111111",
        started_at: "2026-08-19T07:45:00+00:00",
      }),
    ).toEqual({
      claimed: true,
      referenceId: "gref-test",
      status: "captioning",
      attemptId: "11111111-1111-4111-8111-111111111111",
      existingAttemptId: null,
      startedAt: "2026-08-19T07:45:00+00:00",
      reason: null,
    });
  });

  it("preserves the existing attempt on a recovered-worker denial", () => {
    expect(
      parseGameplayReferenceCaptionPermitClaim({
        claimed: false,
        reference_id: "gref-test",
        reason: "not_pending",
        status: "captioning",
        existing_attempt_id: "22222222-2222-4222-8222-222222222222",
        started_at: "2026-08-19T07:45:00+00:00",
      }),
    ).toEqual({
      claimed: false,
      referenceId: "gref-test",
      status: "captioning",
      attemptId: null,
      existingAttemptId: "22222222-2222-4222-8222-222222222222",
      startedAt: "2026-08-19T07:45:00+00:00",
      reason: "not_pending",
    });
  });
});
