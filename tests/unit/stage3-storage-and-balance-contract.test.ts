import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("knowledge document Drive delete contract", () => {
  it("uses the verified owner-aware Drive removal path as the user-facing canonical path", () => {
    const route = source("app/api/knowledge/route.ts");
    const code = source("lib/knowledge/drive-delete-v2.ts");

    expect(route).toContain("deleteKnowledgeDocumentWithVerifiedDriveRemoval");
    expect(route).toContain('from "@/lib/knowledge/drive-delete-v2"');
    expect(code).toContain("export async function deleteKnowledgeDocumentWithVerifiedDriveRemoval");
  });

  it("resolves legacy Drive identities without relying only on drive_file_id", () => {
    const code = source("lib/knowledge/drive-delete.ts");

    expect(code).toContain("resolveKnowledgeDriveFileId");
    expect(code).toContain("document.storage_path");
    expect(code).toContain("metadata.drive_file_id");
    expect(code).toContain("metadata.driveFileId");
    expect(code).toContain("parseGoogleDriveFileId(document.drive_web_url)");
  });

  it("verifies owner/capability state and remote removal before deleting the database row", () => {
    const code = source("lib/knowledge/drive-delete-v2.ts");
    const fn = code.slice(
      code.indexOf("export async function deleteKnowledgeDocumentWithVerifiedDriveRemoval"),
    );
    const capabilityRead = code.indexOf("capabilities(canTrash,canDelete)");
    const verifiedRemoval = fn.indexOf("await removeDriveObjectVerified(driveFileId)");
    const databaseDelete = fn.indexOf('.from("knowledge_documents")\n    .delete()');

    expect(capabilityRead).toBeGreaterThan(-1);
    expect(code).toContain("file.ownedByMe !== true || file.capabilities?.canTrash !== true");
    expect(code).toContain("file.capabilities?.canDelete !== true");
    expect(verifiedRemoval).toBeGreaterThan(-1);
    expect(databaseDelete).toBeGreaterThan(verifiedRemoval);
  });

  it("keeps the database row when Drive ownership or deletion cannot be confirmed", () => {
    const code = source("lib/knowledge/drive-delete-v2.ts");
    const fn = code.slice(
      code.indexOf("export async function deleteKnowledgeDocumentWithVerifiedDriveRemoval"),
    );
    const missingIdFailure = fn.indexOf('throw new Error("DRIVE_FILE_ID_MISSING")');
    const deleteFailureAudit = fn.indexOf("await markDeleteFailure");
    const databaseDelete = fn.indexOf('.from("knowledge_documents")\n    .delete()');

    expect(missingIdFailure).toBeGreaterThan(-1);
    expect(deleteFailureAudit).toBeGreaterThan(-1);
    expect(databaseDelete).toBeGreaterThan(missingIdFailure);
    expect(code).toContain("DRIVE_DELETE_PERMISSION_DENIED");
    expect(code).toContain("DRIVE_DELETE_NOT_VERIFIABLE");
    expect(code).toContain("DRIVE_DELETE_NOT_CONFIRMED");
    expect(code).toContain("drive_delete_failed: true");
  });

  it("keeps the legacy duplicate cleanup helper isolated from the new fail-safe canonical delete", () => {
    const legacy = source("lib/knowledge/drive-delete.ts");
    const canonical = source("lib/knowledge/drive-delete-v2.ts");

    expect(legacy).toContain("cleanupLikelyRetryDuplicates");
    expect(legacy).toContain("protectedIds");
    expect(legacy).toContain("DUPLICATE_CREATED_AT_TOLERANCE_MS");
    expect(canonical).not.toContain("cleanupLikelyRetryDuplicates");
  });

  it("shows delete failures to the user instead of silently removing the row", () => {
    const client = source("components/knowledge/knowledge-page-client.tsx");

    expect(client).toContain("if (!res.ok || !payload?.ok)");
    expect(client).toContain("window.alert");
    expect(client.indexOf("setDocuments((prev) => prev.filter")).toBeGreaterThan(
      client.indexOf("if (!res.ok || !payload?.ok)"),
    );
  });
});

describe("durable generation archive contract", () => {
  it("uses writable container-local storage only as removable staging before Google Drive upload", () => {
    const code = source("lib/generation/drive-archive.ts");
    expect(code).toContain('STAGING_DIR = "generation-archive-staging"');
    expect(code).toContain('DEFAULT_STAGING_ROOT = "/tmp/ai-factory"');
    expect(code).toContain("AI_FACTORY_STAGING_ROOT");
    expect(code).not.toContain("process.env.AI_FACTORY_DATA_ROOT");
    expect(code).toContain("createResumableUpload");
    expect(code).toContain('storageProvider: "google_drive"');
    expect(code).toContain("await rm(tempPath, { force: true })");
    expect(code).toContain('"Generated", kind === "video" ? "Videos" : "Images"');
  });

  it("archives image and video outputs before durable completion", () => {
    for (const path of [
      "lib/orchestrator/generation-images.ts",
      "lib/orchestrator/generation-videos.ts",
    ]) {
      const code = source(path);
      expect(code).toContain("getDefaultMediaArchiveService");
      expect(code.indexOf("await archive.archive")).toBeGreaterThan(-1);
      expect(code.indexOf("orchestrator_complete_")).toBeGreaterThan(code.indexOf("await archive.archive"));
    }
  });

  it("serves archived outputs from Drive with provider URL only as fallback", () => {
    const code = source("app/api/generations/[generationId]/outputs/[outputIndex]/route.ts");
    const driveBranch = code.indexOf('output.storageProvider === "google_drive"');
    const providerFallback = code.indexOf("output.providerUrl ?? output.url");
    expect(driveBranch).toBeGreaterThan(-1);
    expect(providerFallback).toBeGreaterThan(driveBranch);
    expect(code).toContain("fetchDriveOutput");
    expect(code).toContain('url.searchParams.set("alt", "media")');
  });

  it("makes incomplete Google Drive backfill fail the production deployment", () => {
    const route = source("app/api/internal/generation-archive/backfill/route.ts");
    const deploy = source("scripts/deploy.sh");
    expect(route).toContain("status: failures.length === 0 ? 200 : 500");
    expect(deploy).toContain("--fail-with-body");
    expect(deploy).toContain('fail "Media archive backfill failed: $archive_result"');
    expect(deploy).not.toContain("WARNING: media archive backfill could not be completed");
  });
});

describe("KIE balance monitoring contract", () => {
  it("keeps the KIE key server-side and exposes only credits to the sidebar", () => {
    const route = source("app/api/integrations/kie/credits/route.ts");
    const sidebar = source("components/layout/sidebar.tsx");

    expect(route).toContain('https://api.kie.ai/api/v1/chat/credit');
    expect(route).toContain("Authorization: `Bearer ${apiKey}`");
    expect(route).toContain("getSessionUser");
    expect(sidebar).toContain('fetch("/api/integrations/kie/credits"');
    expect(sidebar).not.toContain("KIE_API_KEY");
  });
});
