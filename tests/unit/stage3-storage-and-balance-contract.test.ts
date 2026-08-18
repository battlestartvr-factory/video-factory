import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("knowledge document Drive delete contract", () => {
  it("deletes the Drive object before deleting the database row", () => {
    const code = source("lib/knowledge/knowledge-service.ts");
    const fn = code.slice(code.indexOf("export async function deleteKnowledgeDocument"));
    const driveDelete = fn.indexOf("await drive.deleteFile(driveFileId)");
    const databaseDelete = fn.indexOf('.from("knowledge_documents")\n    .delete()');

    expect(driveDelete).toBeGreaterThan(-1);
    expect(databaseDelete).toBeGreaterThan(driveDelete);
  });

  it("keeps the database row when Drive deletion fails", () => {
    const code = source("lib/knowledge/knowledge-service.ts");
    const fn = code.slice(code.indexOf("export async function deleteKnowledgeDocument"));
    const driveFailure = fn.indexOf('throw new Error(errorCode)');
    const databaseDelete = fn.indexOf('.from("knowledge_documents")\n    .delete()');

    expect(driveFailure).toBeGreaterThan(-1);
    expect(databaseDelete).toBeGreaterThan(driveFailure);
    expect(fn).toContain("drive_delete_failed: true");
  });

  it("blocks user deletion when a Drive-backed row cannot be cleaned remotely", () => {
    const route = source("app/api/knowledge/route.ts");
    const deleteHandler = route.slice(route.indexOf("export async function DELETE"));
    const guard = deleteHandler.indexOf("document.drive_file_id && !isDriveStorageConfigured()");
    const deleteCall = deleteHandler.indexOf("await deleteKnowledgeDocument(user.id, id)");

    expect(guard).toBeGreaterThan(-1);
    expect(deleteCall).toBeGreaterThan(guard);
    expect(deleteHandler).toContain("Google Drive недоступен: документ не удалён");
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
