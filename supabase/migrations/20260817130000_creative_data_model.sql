-- Stage 2: Creative Data Model
-- Additive schema for creative lineage, references, evaluations and experiments.
-- Existing execution tables (agent_runs, factory_jobs, generations) remain the execution layer.
-- Existing memory_items remains the canonical agent memory store and is extended with evidence metadata.

-- ---------------------------------------------------------------------------
-- creative_runs — canonical creative lifecycle record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.creative_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  parent_run_id UUID REFERENCES public.creative_runs(id) ON DELETE SET NULL,
  agent_run_id UUID REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  factory_job_id UUID REFERENCES public.factory_jobs(id) ON DELETE SET NULL,
  generation_id UUID REFERENCES public.generations(id) ON DELETE SET NULL,
  run_type TEXT NOT NULL CHECK (run_type IN ('research', 'concept', 'script', 'image', 'video', 'post', 'mixed')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'queued', 'running', 'completed', 'failed', 'cancelled')),
  title TEXT,
  objective TEXT,
  hypothesis TEXT,
  prompt TEXT,
  model TEXT,
  provider TEXT,
  preset TEXT CHECK (preset IS NULL OR preset IN ('economy', 'balanced', 'quality')),
  parameters JSONB NOT NULL DEFAULT '{}',
  inputs JSONB NOT NULL DEFAULT '{}',
  outputs JSONB NOT NULL DEFAULT '{}',
  usage JSONB NOT NULL DEFAULT '{}',
  estimated_cost_usd NUMERIC(12, 6),
  actual_cost_usd NUMERIC(12, 6),
  error_code TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT creative_runs_costs_nonnegative CHECK (
    (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0)
    AND (actual_cost_usd IS NULL OR actual_cost_usd >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_creative_runs_user_created
  ON public.creative_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_runs_project_created
  ON public.creative_runs (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_runs_parent
  ON public.creative_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_runs_status_updated
  ON public.creative_runs (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_creative_runs_agent_run
  ON public.creative_runs (agent_run_id)
  WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_runs_factory_job
  ON public.creative_runs (factory_job_id)
  WHERE factory_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_runs_generation
  ON public.creative_runs (generation_id)
  WHERE generation_id IS NOT NULL;

DROP TRIGGER IF EXISTS creative_runs_updated_at ON public.creative_runs;
CREATE TRIGGER creative_runs_updated_at
  BEFORE UPDATE ON public.creative_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- creative_references — evidence and inspiration used by a run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.creative_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  reference_type TEXT NOT NULL
    CHECK (reference_type IN ('knowledge', 'web', 'asset', 'creative_run', 'manual', 'other')),
  source_id TEXT,
  source_url TEXT,
  title TEXT,
  excerpt TEXT,
  relevance NUMERIC(5, 4),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT creative_references_relevance_range CHECK (
    relevance IS NULL OR (relevance >= 0 AND relevance <= 1)
  )
);

CREATE INDEX IF NOT EXISTS idx_creative_references_run_created
  ON public.creative_references (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_creative_references_project
  ON public.creative_references (project_id)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_references_type
  ON public.creative_references (reference_type);

-- ---------------------------------------------------------------------------
-- creative_evaluations — human or automated quality measurements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.creative_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  evaluator_type TEXT NOT NULL CHECK (evaluator_type IN ('human', 'agent', 'metric')),
  evaluator TEXT,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'mixed')),
  overall_score NUMERIC(6, 3),
  dimensions JSONB NOT NULL DEFAULT '{}',
  rationale TEXT,
  evidence JSONB NOT NULL DEFAULT '[]',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT creative_evaluations_score_range CHECK (
    overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)
  )
);

CREATE INDEX IF NOT EXISTS idx_creative_evaluations_run_created
  ON public.creative_evaluations (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_evaluations_type
  ON public.creative_evaluations (evaluator_type);

-- ---------------------------------------------------------------------------
-- creative_experiments — explicit hypothesis + run comparison
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.creative_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'completed', 'cancelled')),
  success_metric TEXT,
  success_criteria JSONB NOT NULL DEFAULT '{}',
  variables JSONB NOT NULL DEFAULT '{}',
  conclusion TEXT,
  winner_run_id UUID REFERENCES public.creative_runs(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creative_experiments_user_created
  ON public.creative_experiments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creative_experiments_project_created
  ON public.creative_experiments (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creative_experiments_status
  ON public.creative_experiments (status, updated_at);

DROP TRIGGER IF EXISTS creative_experiments_updated_at ON public.creative_experiments;
CREATE TRIGGER creative_experiments_updated_at
  BEFORE UPDATE ON public.creative_experiments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.creative_experiment_runs (
  experiment_id UUID NOT NULL REFERENCES public.creative_experiments(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL,
  is_control BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (experiment_id, run_id),
  CONSTRAINT creative_experiment_runs_variant_key_nonempty CHECK (length(trim(variant_key)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_creative_experiment_runs_run
  ON public.creative_experiment_runs (run_id);
CREATE INDEX IF NOT EXISTS idx_creative_experiment_runs_variant
  ON public.creative_experiment_runs (experiment_id, variant_key);

-- ---------------------------------------------------------------------------
-- memory_items — evidence-backed learning, without creating a second memory silo
-- ---------------------------------------------------------------------------
ALTER TABLE public.memory_items
  ADD COLUMN IF NOT EXISTS source_run_id UUID REFERENCES public.creative_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(5, 4),
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS learned_from TEXT;

ALTER TABLE public.memory_items
  DROP CONSTRAINT IF EXISTS memory_items_confidence_range;
ALTER TABLE public.memory_items
  ADD CONSTRAINT memory_items_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  );

CREATE INDEX IF NOT EXISTS idx_memory_items_source_run
  ON public.memory_items (source_run_id)
  WHERE source_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS: authenticated users can read their own/project records; writes stay server-side
-- ---------------------------------------------------------------------------
ALTER TABLE public.creative_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creative_experiment_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creative_runs_select ON public.creative_runs;
CREATE POLICY creative_runs_select ON public.creative_runs
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      project_id IS NOT NULL
      AND public.has_project_access((SELECT auth.uid()), project_id)
    )
  );

DROP POLICY IF EXISTS creative_references_select ON public.creative_references;
CREATE POLICY creative_references_select ON public.creative_references
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.creative_runs cr
      WHERE cr.id = run_id
        AND (
          cr.user_id = (SELECT auth.uid())
          OR (
            cr.project_id IS NOT NULL
            AND public.has_project_access((SELECT auth.uid()), cr.project_id)
          )
        )
    )
  );

DROP POLICY IF EXISTS creative_evaluations_select ON public.creative_evaluations;
CREATE POLICY creative_evaluations_select ON public.creative_evaluations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.creative_runs cr
      WHERE cr.id = run_id
        AND (
          cr.user_id = (SELECT auth.uid())
          OR (
            cr.project_id IS NOT NULL
            AND public.has_project_access((SELECT auth.uid()), cr.project_id)
          )
        )
    )
  );

DROP POLICY IF EXISTS creative_experiments_select ON public.creative_experiments;
CREATE POLICY creative_experiments_select ON public.creative_experiments
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      project_id IS NOT NULL
      AND public.has_project_access((SELECT auth.uid()), project_id)
    )
  );

DROP POLICY IF EXISTS creative_experiment_runs_select ON public.creative_experiment_runs;
CREATE POLICY creative_experiment_runs_select ON public.creative_experiment_runs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.creative_experiments ce
      WHERE ce.id = experiment_id
        AND (
          ce.user_id = (SELECT auth.uid())
          OR (
            ce.project_id IS NOT NULL
            AND public.has_project_access((SELECT auth.uid()), ce.project_id)
          )
        )
    )
  );

REVOKE INSERT, UPDATE, DELETE ON public.creative_runs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.creative_references FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.creative_evaluations FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.creative_experiments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.creative_experiment_runs FROM anon, authenticated;
