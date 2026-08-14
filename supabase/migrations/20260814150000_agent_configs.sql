-- Global agent instructions per user (editable in Settings → Agent)
CREATE TABLE IF NOT EXISTS public.agent_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'default',
  system_prompt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_configs_user_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_configs_user ON public.agent_configs (user_id);

DROP TRIGGER IF EXISTS agent_configs_updated_at ON public.agent_configs;
CREATE TRIGGER agent_configs_updated_at
  BEFORE UPDATE ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.agent_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_configs_select ON public.agent_configs;
CREATE POLICY agent_configs_select ON public.agent_configs
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS agent_configs_insert ON public.agent_configs;
CREATE POLICY agent_configs_insert ON public.agent_configs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS agent_configs_update ON public.agent_configs;
CREATE POLICY agent_configs_update ON public.agent_configs
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS agent_configs_delete ON public.agent_configs;
CREATE POLICY agent_configs_delete ON public.agent_configs
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));
