import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchProvider } from "../../lib/web/fetch-provider";
import { KieGeminiGroundedSearchProvider } from "../../lib/web/kie-grounded-search";
import type { WebFetchProvider } from "../../lib/web/types";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260821080000_real_stop_cancellation.sql"),
  "utf8",
);
const worker = readFileSync(join(process.cwd(), "worker/main.ts"), "utf8");
const workerConfig = readFileSync(join(process.cwd(), "worker/config.ts"), "utf8");
const composer = readFileSync(join(process.cwd(), "components/chat/chat-composer.tsx"), "utf8");
const cancelRoute = readFileSync(
  join(process.cwd(), "app/api/discovery/batches/[runId]/cancel/route.ts"),
  "utf8",
);
const scoutFactory = readFileSync(
  join(process.cwd(), "lib/research-intelligence/kie-research-scout.ts"),
  "utf8",
);

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function abortableFetchMock(onStart?: () => void) {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    onStart?.();
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PR1 Real Stop durable cancellation contract", () => {
  it("is an authenticated service-owned cascade, not a browser-side status patch", () => {
    expect(cancelRoute).toContain("getSessionUser");
    expect(cancelRoute).toContain("cancelGameDiscoveryBatch");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.orchestrator_request_cancel");
    expect(migration).toContain("public.has_factory_job_access(p_user_id, p_root_job_id)");
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.orchestrator_request_cancel[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.orchestrator_request_cancel[\s\S]*TO service_role/);
  });

  it("fences root and child leases and makes cancellation terminal/idempotent", () => {
    expect(migration).toContain("cancel_requested = TRUE");
    expect(migration).toContain("status = 'cancelled'");
    expect(migration).toContain("lease_owner = NULL");
    expect(migration).toContain("lease_token = NULL");
    expect(migration).toContain("lease_expires_at = NULL");
    expect(migration).toContain("next_action_at = NULL");
    expect(migration).toContain("ON CONFLICT (dedupe_key) DO NOTHING");
    expect(migration).toContain("'retryable', false");
  });

  it("cascades across Research Scouts, Concept Council, creative descendants and provider bookkeeping", () => {
    expect(migration).toContain("public.research_scout_assignments");
    expect(migration).toContain("public.concept_council_assignments");
    expect(migration).toContain("WITH RECURSIVE root_runs");
    expect(migration).toContain("child.parent_run_id = parent.id");
    expect(migration).toContain("UPDATE public.factory_job_stages");
    expect(migration).toContain("UPDATE public.provider_tasks");
    expect(migration).toContain("UPDATE public.creative_runs");
    expect(migration).toContain("UPDATE public.research_runs");
  });

  it("uses the existing lease heartbeat as a sub-second/one-second cancellation fence", () => {
    expect(workerConfig).toContain('integerEnv("ORCHESTRATOR_LEASE_HEARTBEAT_MS", 1_000, 250');
    expect(worker).toContain("if (!result.renewed)");
    expect(worker).toContain("controller.abort");
    expect(worker).toMatch(/if \(controller\.signal\.aborted \|\| input\.isStopping\(\)\)[\s\S]*return;/);
    expect(worker).toMatch(/if \(leaseLost \|\| controller\.signal\.aborted \|\| input\.isStopping\(\)\)[\s\S]*commit_skipped[\s\S]*return;/);
  });

  it("renders Stop in the same composer control that normally sends a message", () => {
    expect(composer).toContain('aria-label="Остановить"');
    expect(composer).toContain('aria-label="Отправить"');
    expect(composer).toContain("<Square");
    expect(composer).toContain("/cancel");
    expect(composer).toContain('reason: "chat_stop_button"');
    expect(composer).toContain('task.action !== "game_discovery"');
    expect(composer).toContain("workflowVersion");
  });
});

describe("PR1 Real Stop provider abort boundary", () => {
  it("aborts an in-flight KIE grounded-search HTTP request instead of waiting for timeout", async () => {
    const controller = new AbortController();
    const fetchMock = abortableFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const unusedFetchProvider: WebFetchProvider = {
      fetch: async () => { throw new Error("unused"); },
      fetchPage: async () => { throw new Error("unused"); },
      fetchImage: async () => { throw new Error("unused"); },
    };
    const provider = new KieGeminiGroundedSearchProvider(
      "https://api.kie.ai",
      "test-key",
      "gemini-3-6-flash",
      unusedFetchProvider,
      controller.signal,
    );

    const pending = provider.searchText({ query: "co-op mechanics", maxResults: 3 });
    await Promise.resolve();
    controller.abort(new Error("user_stop"));

    await expect(pending).rejects.toThrow("user_stop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });

  it("aborts an in-flight Safe Fetch request and does not continue through redirects", async () => {
    const controller = new AbortController();
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock = abortableFetchMock(markFetchStarted);
    vi.stubGlobal("fetch", fetchMock);
    const provider = createWebFetchProvider(publicLookup, controller.signal);

    const pending = provider.fetchPage("https://example.com/game");
    await fetchStarted;
    controller.abort(new Error("user_stop"));

    await expect(pending).rejects.toThrow("user_stop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });

  it("constructs KIE search and Safe Fetch per Scout execution with the worker AbortSignal", () => {
    expect(scoutFactory).toContain("createWebFetchProvider(undefined, input.signal)");
    expect(scoutFactory).toContain("createKieGeminiGroundedSearchProvider(fetchProvider, input.signal)");
    expect(scoutFactory).toMatch(/if \(input\.signal\.aborted\) throw input\.signal\.reason/);
  });
});
