import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runWf00InfrastructureCheck = vi.fn();

vi.mock("@/lib/env/env.server", () => ({
  serverEnv: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    N8N_FACTORY_BASE_URL: "https://n8n.example.test/webhook",
    FACTORY_WEBHOOK_SECRET: "factory-secret",
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        limit: vi.fn(async () => ({ error: null })),
      })),
    })),
  })),
}));

vi.mock("@/lib/integrations/wf00-check", () => ({
  runWf00InfrastructureCheck: (...args: unknown[]) =>
    runWf00InfrastructureCheck(...args),
}));

describe("getIntegrationsStatus", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    runWf00InfrastructureCheck.mockReset();
    runWf00InfrastructureCheck.mockResolvedValue({
      ok: true,
      n8n: { reachable: true },
      drive: { reachable: true },
      message: "WF00 ok",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports mock workflows disabled when env is absent", async () => {
    vi.stubEnv("MOCK_WORKFLOWS", undefined);

    const { getIntegrationsStatus } = await import("@/lib/integrations/status");
    const status = await getIntegrationsStatus();

    expect(status.mockWorkflows.reachable).toBe(false);
    expect(status.mockWorkflows.message).toContain("Production routing");
    expect(status.supabase.reachable).toBe(true);
    expect(status.n8n.reachable).toBe(true);
    expect(status.googleDrive.reachable).toBe(true);
    expect(runWf00InfrastructureCheck).toHaveBeenCalledOnce();
  });

  it("skips WF00 and disables n8n reachability when mock mode is on", async () => {
    vi.stubEnv("MOCK_WORKFLOWS", "true");

    const { getIntegrationsStatus } = await import("@/lib/integrations/status");
    const status = await getIntegrationsStatus();

    expect(runWf00InfrastructureCheck).not.toHaveBeenCalled();
    expect(status.mockWorkflows.reachable).toBe(true);
    expect(status.n8n.reachable).toBe(false);
    expect(status.n8n.message).toContain("Mock mode");
  });
});
