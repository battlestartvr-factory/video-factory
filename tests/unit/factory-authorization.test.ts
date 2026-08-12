import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { verifyFactoryWebhookAuthHeader } from "@/lib/factory/webhook-auth";

const CREATE_ROUTE = readFileSync(
  join(process.cwd(), "app/api/factory/jobs/route.ts"),
  "utf-8",
);
const ACTION_ROUTE = readFileSync(
  join(process.cwd(), "app/api/factory/jobs/[jobId]/actions/route.ts"),
  "utf-8",
);
const N8N_SERVER = readFileSync(join(process.cwd(), "lib/factory/n8n-server.ts"), "utf-8");

describe("factory authorization — second level checks", () => {
  it("create route validates sourceAssetIds belong to project", () => {
    expect(CREATE_ROUTE).toContain("validateSourceAssetsBelongToProject");
    expect(CREATE_ROUTE).toContain("parsed.data.projectId");
  });

  it("create route checks project editor membership", () => {
    expect(CREATE_ROUTE).toContain("requireProjectEditor");
  });

  it("create route ignores spoofed userId", () => {
    expect(CREATE_ROUTE).toMatch(/parsed\.data\.userId && parsed\.data\.userId !== auth\.user\.id/);
    expect(CREATE_ROUTE).toContain("user_id: auth.user.id");
  });

  it("create route skips n8n when duplicate request_id", () => {
    expect(CREATE_ROUTE).toMatch(/if \(!result\.duplicate\)/);
    expect(CREATE_ROUTE).toContain("n8n dispatch skipped");
  });

  it("actions route validates selected asset belongs to job and stage", () => {
    expect(ACTION_ROUTE).toContain("validateFactoryAssetBelongsToJob");
    expect(ACTION_ROUTE).toContain("INVALID_ASSET");
  });

  it("actions route verifies job access via getFactoryJobForUser", () => {
    expect(ACTION_ROUTE).toContain("getFactoryJobForUser");
    expect(ACTION_ROUTE).toContain("jobResult.job.project_id");
  });

  it("n8n action webhook uses /factory/jobs/action path", () => {
    expect(N8N_SERVER).toContain("FACTORY_JOB_ACTION_WEBHOOK_PATH");
    expect(N8N_SERVER).not.toMatch(/\/factory\/jobs\/\$\{/);
  });

  it("rejects incorrect x-factory-signature on verify", () => {
    expect(verifyFactoryWebhookAuthHeader("bad", "expected-secret")).toBe(false);
    expect(verifyFactoryWebhookAuthHeader("expected-secret", "expected-secret")).toBe(true);
  });
});

describe("factory authorization — legacy isolation", () => {
  it("legacy jobs route remains separate from factory", () => {
    const legacy = readFileSync(join(process.cwd(), "app/api/jobs/route.ts"), "utf-8");
    expect(legacy).toContain('.from("jobs")');
    expect(legacy).not.toContain("factory_jobs");
  });

  it("factory create does not mutate legacy jobs table", () => {
    expect(CREATE_ROUTE).not.toMatch(/\.from\("jobs"\)/);
    expect(CREATE_ROUTE).toContain("factory_create_or_get_job");
  });
});
