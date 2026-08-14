import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260814000000_ai_workspace_schema.sql"),
  "utf-8",
);

describe("AI workspace migration — additive and safe", () => {
  it("does not drop or truncate existing tables", () => {
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("does not modify n8n or factory orchestration tables", () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.factory_jobs\b/);
    expect(migration).not.toMatch(/ALTER TABLE public\.provider_tasks\b/);
    expect(migration).not.toMatch(/ALTER TABLE public\.processed_webhook_events\b/);
  });

  it("creates workspace tables", () => {
    const tables = [
      "chats",
      "chat_messages",
      "chat_attachments",
      "chat_job_links",
      "presets",
      "memory_items",
      "user_preferences",
      "knowledge_bases",
      "knowledge_documents",
      "knowledge_chunks",
      "generations",
    ];
    for (const table of tables) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
    }
  });

  it("extends projects with system_prompt only", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS system_prompt TEXT/);
    expect(migration).not.toMatch(/DROP COLUMN/);
  });

  it("seeds system default presets", () => {
    expect(migration).toMatch(/По умолчанию/);
    expect(migration).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it("revokes client writes on new tables", () => {
    expect(migration).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.chats FROM anon, authenticated/);
    expect(migration).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.generations FROM anon, authenticated/);
  });

  it("enables RLS on all new tables", () => {
    const tables = ["chats", "chat_messages", "presets", "memory_items", "generations"];
    for (const table of tables) {
      expect(migration).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    }
  });
});
