-- Stage 3: Durable Core Orchestrator — schema foundation
-- Additive-first migration. Existing content-era factory RPCs remain compatible.
-- Queue/RPC execution primitives are implemented in the next Stage 3 slice.

-- ---------------------------------------------------------------------------
-- factory_jobs: generic durable workflow identity + persisted scheduler/lease state
-- ---------------------------------------------------------------------------
ALTER TABLE public.factory_jobs
  ADD COLUMN IF NOT EXISTS workflow_kind TEXT,
  ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS state JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS next_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_enqueued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS state_reason TEXT,
  ADD COLUMN IF NOT EXISTS retry_of_job_id UUID;

-- Existing rows are legacy content workflows. Backfill before enforcing workflow identity.
UPDATE public.factory_jobs
SET workflow_kind = 'legacy_content'
WHERE workflow_kind IS NULL;

ALTER TABLE public.factory_jobs
  ALTER COLUMN workflow_kind SET NOT NULL,
  ALTER COLUMN project_id DROP NOT NULL,
  ALTER COLUMN job_type DROP NOT NULL,
  ALTER COLUMN preset DROP NOT NULL,
  ALTER COLUMN content_namespace DROP NOT NULL;

ALTER TABLE public.factory_jobs
  DROP CONSTRAINT IF EXISTS factory_jobs_job_type_check,
  DROP CONSTRAINT IF EXISTS factory_jobs_preset_check,
  DROP CONSTRAINT IF EXISTS factory_jobs_content_namespace_check,
  DROP CONSTRAINT IF EXISTS factory_jobs_status_check,
  DROP CONSTRAINT IF EXISTS factory_jobs_ai_game_lab_disclosure_check,
  DROP CONSTRAINT IF EXISTS factory_jobs_workflow_kind_nonempty,
  DROP CONSTRAINT IF EXISTS factory_jobs_workflow_version_positive,
  DROP CONSTRAINT IF EXISTS factory_jobs_legacy_contract_check,
  DROP CONSTRAINT IF EXISTS factory_jobs_lease_consistency_check,
  DROP CONSTRAINT IF EXISTS factory_jobs_retry_of_job_id_fkey;

ALTER TABLE public.factory_jobs
  ADD CONSTRAINT factory_jobs_job_type_check
    CHECK (job_type IS NULL OR job_type IN ('script', 'post', 'image', 'short_video', 'dev_diary')),
  ADD CONSTRAINT factory_jobs_preset_check
    CHECK (preset IS NULL OR preset IN ('economy', 'balanced', 'quality')),
  ADD CONSTRAINT factory_jobs_content_namespace_check
    CHECK (content_namespace IS NULL OR content_namespace IN ('dev_reality', 'ai_game_lab')),
  ADD CONSTRAINT factory_jobs_status_check
    CHECK (status IN (
      'queued', 'running', 'waiting', 'awaiting_approval', 'retrying',
      'completed', 'failed', 'cancelled'
    )),
  ADD CONSTRAINT factory_jobs_workflow_kind_nonempty
    CHECK (length(trim(workflow_kind)) > 0),
  ADD CONSTRAINT factory_jobs_workflow_version_positive
    CHECK (workflow_version > 0),
  ADD CONSTRAINT factory_jobs_legacy_contract_check
    CHECK (
      workflow_kind <> 'legacy_content'
      OR (
        job_type IS NOT NULL
        AND preset IS NOT NULL
        AND content_namespace IS NOT NULL
        AND (
          content_namespace <> 'ai_game_lab'
          OR concept_disclosure_required = true
        )
      )
    ),
  ADD CONSTRAINT factory_jobs_lease_consistency_check
    CHECK (
      (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  ADD CONSTRAINT factory_jobs_retry_of_job_id_fkey
    FOREIGN KEY (retry_of_job_id) REFERENCES public.factory_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_factory_jobs_due
  ON public.factory_jobs (next_action_at, status)
  WHERE status IN ('queued', 'waiting', 'retrying');
CREATE INDEX IF NOT EXISTS idx_factory_jobs_lease_expiry
  ON public.factory_jobs (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_factory_jobs_workflow_created
  ON public.factory_jobs (workflow_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_factory_jobs_retry_parent
  ON public.factory_jobs (retry_of_job_id)
  WHERE retry_of_job_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- factory_job_stages: recovery-aware attempt history + creative lineage
-- ---------------------------------------------------------------------------
ALTER TABLE public.factory_job_stages
  ADD COLUMN IF NOT EXISTS creative_run_id UUID;

ALTER TABLE public.factory_job_stages
  DROP CONSTRAINT IF EXISTS factory_job_stages_status_check,
  DROP CONSTRAINT IF EXISTS factory_job_stages_creative_run_id_fkey;

ALTER TABLE public.factory_job_stages
  ADD CONSTRAINT factory_job_stages_status_check
    CHECK (status IN (
      'queued', 'running', 'submitted', 'processing',
      'succeeded', 'failed', 'interrupted', 'cancelled'
    )),
  ADD CONSTRAINT factory_job_stages_creative_run_id_fkey
    FOREIGN KEY (creative_run_id) REFERENCES public.creative_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_factory_job_stages_creative_run
  ON public.factory_job_stages (creative_run_id)
  WHERE creative_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- provider_tasks: durable external side-effect lifecycle and reconciliation
-- ---------------------------------------------------------------------------
ALTER TABLE public.provider_tasks
  ADD COLUMN IF NOT EXISTS creative_run_id UUID,
  ADD COLUMN IF NOT EXISTS submission_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS callback_token UUID,
  ADD COLUMN IF NOT EXISTS callback_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS request_payload_hash TEXT,
  ADD COLUMN IF NOT EXISTS response_payload_hash TEXT;

ALTER TABLE public.provider_tasks
  DROP CONSTRAINT IF EXISTS provider_tasks_status_check,
  DROP CONSTRAINT IF EXISTS provider_tasks_submission_attempts_nonnegative,
  DROP CONSTRAINT IF EXISTS provider_tasks_creative_run_id_fkey;

ALTER TABLE public.provider_tasks
  ADD CONSTRAINT provider_tasks_status_check
    CHECK (status IN (
      'queued', 'submitting', 'submitted', 'processing', 'reconciling',
      'succeeded', 'failed', 'cancelled'
    )),
  ADD CONSTRAINT provider_tasks_submission_attempts_nonnegative
    CHECK (submission_attempts >= 0),
  ADD CONSTRAINT provider_tasks_creative_run_id_fkey
    FOREIGN KEY (creative_run_id) REFERENCES public.creative_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_provider_tasks_due_check
  ON public.provider_tasks (next_check_at, status)
  WHERE status IN ('submitted', 'processing', 'reconciling');
CREATE INDEX IF NOT EXISTS idx_provider_tasks_creative_run
  ON public.provider_tasks (creative_run_id)
  WHERE creative_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- workflow events + cost events: direct lineage and idempotent accounting
-- ---------------------------------------------------------------------------
ALTER TABLE public.factory_workflow_events
  ADD COLUMN IF NOT EXISTS creative_run_id UUID;

ALTER TABLE public.factory_workflow_events
  DROP CONSTRAINT IF EXISTS factory_workflow_events_creative_run_id_fkey;
ALTER TABLE public.factory_workflow_events
  ADD CONSTRAINT factory_workflow_events_creative_run_id_fkey
    FOREIGN KEY (creative_run_id) REFERENCES public.creative_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_factory_workflow_events_creative_run_created
  ON public.factory_workflow_events (creative_run_id, created_at)
  WHERE creative_run_id IS NOT NULL;

ALTER TABLE public.factory_cost_events
  ADD COLUMN IF NOT EXISTS creative_run_id UUID,
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

-- Existing accounting rows predate Stage 3 dedupe. Give each one a stable legacy key.
UPDATE public.factory_cost_events
SET dedupe_key = 'legacy:' || id::TEXT
WHERE dedupe_key IS NULL;

ALTER TABLE public.factory_cost_events
  ALTER COLUMN dedupe_key SET NOT NULL,
  DROP CONSTRAINT IF EXISTS factory_cost_events_dedupe_key_key,
  DROP CONSTRAINT IF EXISTS factory_cost_events_creative_run_id_fkey;

ALTER TABLE public.factory_cost_events
  ADD CONSTRAINT factory_cost_events_dedupe_key_key UNIQUE (dedupe_key),
  ADD CONSTRAINT factory_cost_events_creative_run_id_fkey
    FOREIGN KEY (creative_run_id) REFERENCES public.creative_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_factory_cost_events_creative_run_created
  ON public.factory_cost_events (creative_run_id, created_at)
  WHERE creative_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- orchestrator_workers: observability heartbeat, never a locking primitive
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orchestrator_workers (
  worker_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  build_sha TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT orchestrator_workers_worker_id_nonempty CHECK (length(trim(worker_id)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_orchestrator_workers_heartbeat
  ON public.orchestrator_workers (last_heartbeat_at);

ALTER TABLE public.orchestrator_workers ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.orchestrator_workers FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Access semantics: project-less studio jobs remain visible to their owner.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_factory_job_access(uid UUID, p_job_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.factory_jobs AS fj
    WHERE fj.id = p_job_id
      AND (
        fj.user_id = uid
        OR (
          fj.project_id IS NOT NULL
          AND public.has_project_access(uid, fj.project_id)
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.has_factory_job_access(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_factory_job_access(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_factory_job_access(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_factory_job_access(UUID, UUID) TO service_role;

DROP POLICY IF EXISTS factory_jobs_select ON public.factory_jobs;
CREATE POLICY factory_jobs_select ON public.factory_jobs
  FOR SELECT
  USING (
    user_id = (SELECT auth.uid())
    OR (
      project_id IS NOT NULL
      AND public.has_project_access((SELECT auth.uid()), project_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Client-safe detail projection. Existing columns keep their original order;
-- Stage 3 fields are appended so CREATE OR REPLACE VIEW is production-safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.factory_job_detail
WITH (security_invoker = true)
AS
SELECT
  fj.id,
  fj.request_id,
  fj.project_id,
  fj.user_id,
  fj.job_type,
  fj.preset,
  fj.content_namespace,
  fj.concept_disclosure_required,
  fj.status,
  fj.current_stage,
  fj.progress,
  fj.input,
  fj.result,
  fj.error,
  fj.cancel_requested,
  fj.estimated_cost_usd,
  fj.actual_cost_usd,
  fj.created_at,
  fj.updated_at,
  fj.completed_at,
  COALESCE(
    (
      SELECT SUM(ce.cost_usd)
      FROM public.factory_cost_events AS ce
      WHERE ce.job_id = fj.id AND ce.estimated = false
    ),
    fj.actual_cost_usd,
    0
  ) AS aggregated_actual_cost_usd,
  fj.workflow_kind,
  fj.workflow_version,
  fj.state,
  fj.state_reason,
  fj.next_action_at,
  fj.last_enqueued_at,
  fj.retry_of_job_id
FROM public.factory_jobs AS fj;

GRANT SELECT ON public.factory_job_detail TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.factory_job_detail FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.factory_job_detail FROM anon;
