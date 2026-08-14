-- Universal Agent — additive schema for agent runs, tool audit, durable actions
-- Does NOT drop tables, wipe data, or rewrite existing workspace / factory tables.

-- ---------------------------------------------------------------------------
-- agent_runs — one durable record per agent turn
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  user_message_id UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  assistant_message_id UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  usage JSONB NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_chat_started
  ON public.agent_runs (chat_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_started
  ON public.agent_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_request
  ON public.agent_runs (request_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project
  ON public.agent_runs (project_id)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_message
  ON public.agent_runs (user_message_id)
  WHERE user_message_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- agent_tool_runs — audit trail for each tool invocation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_tool_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_run_started
  ON public.agent_tool_runs (agent_run_id, started_at ASC);
CREATE INDEX IF NOT EXISTS idx_agent_tool_runs_tool_name
  ON public.agent_tool_runs (tool_name);

-- ---------------------------------------------------------------------------
-- agent_actions — durable long-running operations (image/video generation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  chat_id UUID REFERENCES public.chats(id) ON DELETE SET NULL,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  generation_id UUID REFERENCES public.generations(id) ON DELETE SET NULL,
  source_message_id UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_dispatch'
    CHECK (status IN (
      'pending_dispatch',
      'dispatched',
      'processing',
      'completed',
      'failed',
      'cancelled'
    )),
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_run
  ON public.agent_actions (agent_run_id)
  WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_actions_generation
  ON public.agent_actions (generation_id)
  WHERE generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_actions_user_status
  ON public.agent_actions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_actions_chat
  ON public.agent_actions (chat_id)
  WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_actions_project
  ON public.agent_actions (project_id)
  WHERE project_id IS NOT NULL;

DROP TRIGGER IF EXISTS agent_actions_updated_at ON public.agent_actions;
CREATE TRIGGER agent_actions_updated_at
  BEFORE UPDATE ON public.agent_actions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_tool_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_runs_select ON public.agent_runs;
CREATE POLICY agent_runs_select ON public.agent_runs
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      project_id IS NOT NULL
      AND public.has_project_access((SELECT auth.uid()), project_id)
    )
  );

DROP POLICY IF EXISTS agent_tool_runs_select ON public.agent_tool_runs;
CREATE POLICY agent_tool_runs_select ON public.agent_tool_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.agent_runs r
      WHERE r.id = agent_run_id
        AND (
          r.user_id = (SELECT auth.uid())
          OR (
            r.project_id IS NOT NULL
            AND public.has_project_access((SELECT auth.uid()), r.project_id)
          )
        )
    )
  );

DROP POLICY IF EXISTS agent_actions_select ON public.agent_actions;
CREATE POLICY agent_actions_select ON public.agent_actions
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      project_id IS NOT NULL
      AND public.has_project_access((SELECT auth.uid()), project_id)
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.agent_runs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.agent_tool_runs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.agent_actions FROM anon, authenticated;
