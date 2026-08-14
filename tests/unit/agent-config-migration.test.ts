import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agent_configs migration", () => {
  const migration = readFileSync(
    join(process.cwd(), "supabase/migrations/20260814150000_agent_configs.sql"),
    "utf8",
  );

  it("creates agent_configs with unique user_id", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.agent_configs/);
    expect(migration).toMatch(/system_prompt TEXT NOT NULL/);
    expect(migration).toMatch(/version INTEGER NOT NULL DEFAULT 1/);
    expect(migration).toMatch(/CONSTRAINT agent_configs_user_unique UNIQUE \(user_id\)/);
  });

  it("enables RLS for authenticated users", () => {
    expect(migration).toMatch(/ALTER TABLE public\.agent_configs ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/agent_configs_select/);
    expect(migration).toMatch(/agent_configs_update/);
  });
});

describe("chat delete cascade schema", () => {
  const workspaceMigration = readFileSync(
    join(process.cwd(), "supabase/migrations/20260814000000_ai_workspace_schema.sql"),
    "utf8",
  );
  const agentMigration = readFileSync(
    join(process.cwd(), "supabase/migrations/20260814120000_universal_agent.sql"),
    "utf8",
  );

  it("cascades chat_messages and chat_attachments on chat delete", () => {
    expect(workspaceMigration).toMatch(
      /chat_id UUID NOT NULL REFERENCES public\.chats\(id\) ON DELETE CASCADE/,
    );
  });

  it("cascades agent_runs and agent_tool_runs on chat delete", () => {
    expect(agentMigration).toMatch(
      /chat_id UUID NOT NULL REFERENCES public\.chats\(id\) ON DELETE CASCADE/,
    );
    expect(agentMigration).toMatch(
      /agent_run_id UUID NOT NULL REFERENCES public\.agent_runs\(id\) ON DELETE CASCADE/,
    );
  });

  it("detaches generations and agent_actions on chat delete", () => {
    expect(workspaceMigration).toMatch(
      /chat_id UUID REFERENCES public\.chats\(id\) ON DELETE SET NULL/,
    );
    expect(agentMigration).toMatch(
      /chat_id UUID REFERENCES public\.chats\(id\) ON DELETE SET NULL/,
    );
  });
});
