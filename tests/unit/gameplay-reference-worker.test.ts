import { afterEach, describe, expect, it } from "vitest";
import { gameplayReferenceIndexV1 } from "../../worker/workflows/gameplay-reference-index-v1";

const originalFetch = global.fetch;
const originalRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalInternalUrl = process.env.WORKER_APP_INTERNAL_URL;

afterEach(() => {
  global.fetch = originalFetch;
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalRoleKey;
  process.env.WORKER_APP_INTERNAL_URL = originalInternalUrl;
});

function context(state: Record<string, unknown>) {
  return {
    jobId: "00000000-0000-0000-0000-000000000001",
    workflowKind: "gameplay_reference_index",
    workflowVersion: 1,
    currentStage: null,
    state,
    retryCount: 0,
    signal: new AbortController().signal,
  };
}

describe("gameplay_reference_index@1", () => {
  it("completes from one internal indexing request", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-token";
    process.env.WORKER_APP_INTERNAL_URL = "http://app:3000";
    const requestedUrls: string[] = [];
    let calls = 0;
    global.fetch = (async (input) => {
      calls += 1;
      requestedUrls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            reference_id: "gref-test",
            game_name: "R.E.P.O.",
            camera_type: "first_person",
            controllable_player_obvious: true,
            coop_dependency_visible: true,
            current_player_action: "pulls a shared object",
            visible_input_affordance: "held grab tool",
            game_response: "object shifts",
            gameplay_description: "concrete gameplay description",
            why_this_looks_like_gameplay: "player camera and direct world response",
            canonical_reference_id: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await gameplayReferenceIndexV1(context({ reference_id: "gref-test" }));
    expect(result.status).toBe("completed");
    expect(result.currentStage).toBe("indexed");
    expect(calls).toBe(1);
    expect(requestedUrls).toEqual(["http://app:3000/api/internal/gameplay-reference-index"]);
  });

  it("returns a terminal failure and never asks the orchestrator to retry", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-token";
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          ok: false,
          code: "GAMEPLAY_REFERENCE_CAPTION_INVALID",
          message: "schema rejected",
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await gameplayReferenceIndexV1(context({ reference_id: "gref-bad" }));
    expect(result.status).toBe("failed");
    expect(result.error?.retryable).toBe(false);
    expect(result.state?.automatic_retry_allowed).toBe(false);
    expect(result.enqueueReason).toBeUndefined();
    expect(calls).toBe(1);
  });
});
