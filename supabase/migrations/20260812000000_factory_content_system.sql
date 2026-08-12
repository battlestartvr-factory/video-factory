-- AI Content Factory — additive factory pipeline (parallel to legacy jobs/assets)
-- Safe to re-run fragments via IF NOT EXISTS / OR REPLACE where applicable.
-- Does NOT modify or drop existing jobs, assets, reviews, job_events, usage_records.

-- ---------------------------------------------------------------------------
-- projects: factory_settings
-- ---------------------------------------------------------------------------
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS factory_settings JSONB NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- factory_jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.factory_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  project_id UUID NOT NULL,
  user_id UUID NOT NULL,
  job_type TEXT NOT NULL,
  preset TEXT NOT NULL,
  content_namespace TEXT NOT NULL,
  concept_disclosure_required BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'queued',
  current_stage TEXT,
  progress SMALLINT NOT NULL DEFAULT 0,
  input JSONB NOT NULL DEFAULT '{}',
  result JSONB NOT NULL DEFAULT '{}',
  error JSONB,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  estimated_cost_usd NUMERIC(12, 6),
  actual_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT factory_jobs_request_id_key UNIQUE (request_id),
  CONSTRAINT factory_jobs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  CONSTRAINT factory_jobs_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT factory_jobs_job_type_check
    CHECK (job_type IN ('script', 'post', 'image', 'short_video', 'dev_diary')),
  CONSTRAINT factory_jobs_preset_check
    CHECK (preset IN ('economy', 'balanced', 'quality')),
  CONSTRAINT factory_jobs_content_namespace_check
    CHECK (content_namespace IN ('dev_reality', 'ai_game_lab')),
  CONSTRAINT factory_jobs_status_check
    CHECK (status IN (
      'queued', 'running', 'awaiting_approval', 'retrying',
      'completed', 'failed', 'cancelled'
    )),
  CONSTRAINT factory_jobs_progress_check
    CHECK (progress >= 0 AND progress <= 100),
  CONSTRAINT factory_jobs_ai_game_lab_disclosure_check
    CHECK (
      content_namespace <> 'ai_game_lab'
      OR concept_disclosure_required = true
    )
);

CREATE INDEX IF NOT EXISTS idx_factory_jobs_project_created
  ON public.factory_jobs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_factory_jobs_user_created
  ON public.factory_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_factory_jobs_status_updated
  ON public.factory_jobs (status, updated_at);

DROP TRIGGER IF EXISTS factory_jobs_updated_at ON public.factory_jobs;
CREATE TRIGGER factory_jobs_updated_at
  BEFORE UPDATE ON public.factory_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- factory_job_stages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.factory_job_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB NOT NULL DEFAULT '{}',
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_job_stages_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  CONSTRAINT factory_job_stages_status_check
    CHECK (status IN (
      'queued', 'running', 'submitted', 'processing',
      'succeeded', 'failed', 'cancelled'
    )),
  CONSTRAINT factory_job_stages_attempt_check
    CHECK (attempt > 0),
  CONSTRAINT factory_job_stages_job_stage_attempt_key
    UNIQUE (job_id, stage, attempt)
);

CREATE INDEX IF NOT EXISTS idx_factory_job_stages_job_stage_attempt
  ON public.factory_job_stages (job_id, stage, attempt DESC);

DROP TRIGGER IF EXISTS factory_job_stages_updated_at ON public.factory_job_stages;
CREATE TRIGGER factory_job_stages_updated_at
  BEFORE UPDATE ON public.factory_job_stages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- provider_models
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  capability TEXT NOT NULL,
  preset TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  parameters JSONB NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 100,
  estimated_cost JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_models_capability_check
    CHECK (capability IN ('llm', 'image', 'video', 'audio')),
  CONSTRAINT provider_models_preset_check
    CHECK (preset IN ('economy', 'balanced', 'quality')),
  CONSTRAINT provider_models_provider_capability_preset_model_key
    UNIQUE (provider, capability, preset, model)
);

CREATE INDEX IF NOT EXISTS idx_provider_models_capability_preset_enabled_priority
  ON public.provider_models (capability, preset, enabled, priority);

DROP TRIGGER IF EXISTS provider_models_updated_at ON public.provider_models;
CREATE TRIGGER provider_models_updated_at
  BEFORE UPDATE ON public.provider_models
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- provider_tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  stage_id UUID NOT NULL,
  provider_model_id UUID,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  submission_key TEXT NOT NULL,
  external_task_id TEXT,
  variant_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}',
  response_payload JSONB NOT NULL DEFAULT '{}',
  error JSONB,
  credits_used NUMERIC(18, 6),
  cost_usd NUMERIC(12, 6),
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_tasks_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  CONSTRAINT provider_tasks_stage_id_fkey
    FOREIGN KEY (stage_id) REFERENCES public.factory_job_stages(id) ON DELETE CASCADE,
  CONSTRAINT provider_tasks_provider_model_id_fkey
    FOREIGN KEY (provider_model_id) REFERENCES public.provider_models(id) ON DELETE SET NULL,
  CONSTRAINT provider_tasks_submission_key_key UNIQUE (submission_key),
  CONSTRAINT provider_tasks_status_check
    CHECK (status IN (
      'queued', 'submitted', 'processing', 'succeeded', 'failed', 'cancelled'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_tasks_provider_external_task_id
  ON public.provider_tasks (provider, external_task_id)
  WHERE external_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_provider_tasks_job_status
  ON public.provider_tasks (job_id, status);
CREATE INDEX IF NOT EXISTS idx_provider_tasks_status_updated
  ON public.provider_tasks (status, updated_at);

DROP TRIGGER IF EXISTS provider_tasks_updated_at ON public.provider_tasks;
CREATE TRIGGER provider_tasks_updated_at
  BEFORE UPDATE ON public.provider_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- factory_assets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.factory_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  stage_id UUID,
  provider_task_id UUID,
  variant_index INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  storage TEXT NOT NULL,
  bucket TEXT,
  object_key TEXT,
  drive_file_id TEXT,
  drive_web_url TEXT,
  source_url TEXT,
  text_content TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  checksum_sha256 TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  approved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_assets_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  CONSTRAINT factory_assets_stage_id_fkey
    FOREIGN KEY (stage_id) REFERENCES public.factory_job_stages(id) ON DELETE SET NULL,
  CONSTRAINT factory_assets_provider_task_id_fkey
    FOREIGN KEY (provider_task_id) REFERENCES public.provider_tasks(id) ON DELETE SET NULL,
  CONSTRAINT factory_assets_kind_check
    CHECK (kind IN ('text', 'image', 'video', 'audio', 'document', 'metadata')),
  CONSTRAINT factory_assets_storage_check
    CHECK (storage IN ('inline', 'b2', 'drive')),
  CONSTRAINT factory_assets_size_bytes_check
    CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT factory_assets_b2_fields_check
    CHECK (storage <> 'b2' OR (bucket IS NOT NULL AND object_key IS NOT NULL)),
  CONSTRAINT factory_assets_drive_fields_check
    CHECK (storage <> 'drive' OR drive_file_id IS NOT NULL),
  CONSTRAINT factory_assets_inline_fields_check
    CHECK (storage <> 'inline' OR text_content IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_assets_provider_task_variant
  ON public.factory_assets (provider_task_id, variant_index)
  WHERE provider_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_factory_assets_job_created
  ON public.factory_assets (job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_assets_job_approved
  ON public.factory_assets (job_id, approved);

DROP TRIGGER IF EXISTS factory_assets_updated_at ON public.factory_assets;
CREATE TRIGGER factory_assets_updated_at
  BEFORE UPDATE ON public.factory_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- factory_approvals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.factory_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  job_id UUID NOT NULL,
  user_id UUID NOT NULL,
  stage TEXT NOT NULL,
  decision TEXT NOT NULL,
  comment TEXT,
  selected_asset_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_approvals_request_id_key UNIQUE (request_id),
  CONSTRAINT factory_approvals_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  CONSTRAINT factory_approvals_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT factory_approvals_selected_asset_id_fkey
    FOREIGN KEY (selected_asset_id) REFERENCES public.factory_assets(id) ON DELETE SET NULL,
  CONSTRAINT factory_approvals_decision_check
    CHECK (decision IN ('approve', 'regenerate', 'cancel'))
);

CREATE INDEX IF NOT EXISTS idx_factory_approvals_job_created
  ON public.factory_approvals (job_id, created_at);

-- ---------------------------------------------------------------------------
-- factory_workflow_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.factory_workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  stage_id UUID,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_workflow_events_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  CONSTRAINT factory_workflow_events_stage_id_fkey
    FOREIGN KEY (stage_id) REFERENCES public.factory_job_stages(id) ON DELETE SET NULL,
  CONSTRAINT factory_workflow_events_dedupe_key_key UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_factory_workflow_events_job_created
  ON public.factory_workflow_events (job_id, created_at);

-- ---------------------------------------------------------------------------
-- factory_cost_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.factory_cost_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  stage_id UUID,
  provider_task_id UUID,
  provider TEXT NOT NULL,
  model TEXT,
  capability TEXT NOT NULL,
  units JSONB NOT NULL DEFAULT '{}',
  credits NUMERIC(18, 6),
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  estimated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT factory_cost_events_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  CONSTRAINT factory_cost_events_stage_id_fkey
    FOREIGN KEY (stage_id) REFERENCES public.factory_job_stages(id) ON DELETE SET NULL,
  CONSTRAINT factory_cost_events_provider_task_id_fkey
    FOREIGN KEY (provider_task_id) REFERENCES public.provider_tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_factory_cost_events_job_created
  ON public.factory_cost_events (job_id, created_at);

-- ---------------------------------------------------------------------------
-- Helpers
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
      AND public.has_project_access(uid, fj.project_id)
  );
$$;

REVOKE ALL ON FUNCTION public.has_factory_job_access(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_factory_job_access(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_factory_job_access(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_factory_job_access(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- Safe views (security_invoker=true — RLS of caller applies to base tables)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.factory_job_stages_safe
WITH (security_invoker = true)
AS
SELECT
  js.id,
  js.job_id,
  js.stage,
  js.status,
  js.attempt,
  js.started_at,
  js.finished_at,
  js.created_at,
  js.updated_at
FROM public.factory_job_stages AS js;

CREATE OR REPLACE VIEW public.factory_assets_safe
WITH (security_invoker = true)
AS
SELECT
  fa.id,
  fa.job_id,
  fa.stage_id,
  fa.variant_index,
  fa.kind,
  fa.storage,
  CASE
    WHEN fa.storage = 'b2' THEN NULL
    ELSE fa.source_url
  END AS source_url,
  fa.drive_web_url,
  CASE
    WHEN fa.storage = 'inline' OR fa.kind = 'text' THEN fa.text_content
    ELSE NULL
  END AS text_content,
  fa.mime_type,
  fa.size_bytes,
  fa.approved,
  fa.created_at,
  fa.updated_at
FROM public.factory_assets AS fa;

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
  ) AS aggregated_actual_cost_usd
FROM public.factory_jobs AS fj;

-- ---------------------------------------------------------------------------
-- RPC: factory_create_or_get_job
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.factory_create_or_get_job(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request_id UUID;
  v_project_id UUID;
  v_user_id UUID;
  v_job_type TEXT;
  v_preset TEXT;
  v_content_namespace TEXT;
  v_concept_disclosure BOOLEAN;
  v_input JSONB;
  v_job_id UUID;
  v_status TEXT;
  v_duplicate BOOLEAN := false;
BEGIN
  v_request_id := NULLIF(payload->>'request_id', '')::UUID;
  v_project_id := NULLIF(payload->>'project_id', '')::UUID;
  v_user_id := NULLIF(payload->>'user_id', '')::UUID;
  v_job_type := payload->>'job_type';
  v_preset := payload->>'preset';
  v_content_namespace := payload->>'content_namespace';
  v_input := COALESCE(payload->'input', '{}'::JSONB);

  IF v_request_id IS NULL
    OR v_project_id IS NULL
    OR v_user_id IS NULL
    OR v_job_type IS NULL
    OR v_preset IS NULL
    OR v_content_namespace IS NULL
  THEN
    RAISE EXCEPTION 'invalid payload: missing required fields';
  END IF;

  v_concept_disclosure := COALESCE((payload->>'concept_disclosure_required')::BOOLEAN, false);
  IF v_content_namespace = 'ai_game_lab' THEN
    v_concept_disclosure := true;
  END IF;

  INSERT INTO public.factory_jobs (
    request_id,
    project_id,
    user_id,
    job_type,
    preset,
    content_namespace,
    concept_disclosure_required,
    status,
    input
  )
  VALUES (
    v_request_id,
    v_project_id,
    v_user_id,
    v_job_type,
    v_preset,
    v_content_namespace,
    v_concept_disclosure,
    'queued',
    v_input
  )
  ON CONFLICT (request_id) DO NOTHING
  RETURNING id, status INTO v_job_id, v_status;

  IF v_job_id IS NULL THEN
    SELECT fj.id, fj.status
    INTO v_job_id, v_status
    FROM public.factory_jobs fj
    WHERE fj.request_id = v_request_id;
    v_duplicate := true;
  ELSE
    INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
    VALUES (
      v_job_id,
      'job.accepted',
      'job:accepted:' || v_request_id::TEXT,
      jsonb_build_object('request_id', v_request_id)
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'job_id', v_job_id,
    'status', v_status,
    'duplicate', v_duplicate
  );
END;
$$;

REVOKE ALL ON FUNCTION public.factory_create_or_get_job(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.factory_create_or_get_job(JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC: factory_claim_stage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.factory_claim_stage(
  p_job_id UUID,
  p_stage TEXT,
  p_input JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_status TEXT;
  v_existing RECORD;
  v_next_attempt INTEGER;
  v_stage_id UUID;
BEGIN
  SELECT status
  INTO v_job_status
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found';
  END IF;

  IF v_job_status IN ('cancelled', 'completed') THEN
    RAISE EXCEPTION 'job is terminal: %', v_job_status;
  END IF;

  SELECT js.id, js.status, js.attempt
  INTO v_existing
  FROM public.factory_job_stages js
  WHERE js.job_id = p_job_id
    AND js.stage = p_stage
    AND js.status IN ('running', 'submitted', 'processing', 'succeeded')
  ORDER BY js.attempt DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'stage_id', v_existing.id,
      'status', v_existing.status,
      'attempt', v_existing.attempt,
      'duplicate', true
    );
  END IF;

  SELECT COALESCE(MAX(attempt), 0) + 1
  INTO v_next_attempt
  FROM public.factory_job_stages
  WHERE job_id = p_job_id AND stage = p_stage;

  INSERT INTO public.factory_job_stages (job_id, stage, status, attempt, input, started_at)
  VALUES (p_job_id, p_stage, 'running', v_next_attempt, COALESCE(p_input, '{}'::JSONB), NOW())
  RETURNING id INTO v_stage_id;

  UPDATE public.factory_jobs
  SET
    current_stage = p_stage,
    status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
    updated_at = NOW()
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'stage_id', v_stage_id,
    'status', 'running',
    'attempt', v_next_attempt,
    'duplicate', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.factory_claim_stage(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.factory_claim_stage(UUID, TEXT, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC: factory_record_event
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.factory_record_event(
  p_job_id UUID,
  p_stage_id UUID,
  p_event_type TEXT,
  p_dedupe_key TEXT,
  p_payload JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id UUID;
BEGIN
  INSERT INTO public.factory_workflow_events (job_id, stage_id, event_type, dedupe_key, payload)
  VALUES (p_job_id, p_stage_id, p_event_type, p_dedupe_key, COALESCE(p_payload, '{}'::JSONB))
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN jsonb_build_object('inserted', false, 'event_id', NULL);
  END IF;

  RETURN jsonb_build_object('inserted', true, 'event_id', v_event_id);
END;
$$;

REVOKE ALL ON FUNCTION public.factory_record_event(UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.factory_record_event(UUID, UUID, TEXT, TEXT, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC: factory_transition_job
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.factory_transition_job(
  p_job_id UUID,
  p_expected_statuses TEXT[],
  p_new_status TEXT,
  p_progress SMALLINT DEFAULT NULL,
  p_stage TEXT DEFAULT NULL,
  p_result JSONB DEFAULT NULL,
  p_error JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_updated INTEGER;
BEGIN
  SELECT status INTO v_current_status
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'job_not_found');
  END IF;

  IF v_current_status IN ('completed', 'cancelled')
    AND p_new_status IN ('running', 'queued', 'retrying', 'awaiting_approval')
  THEN
    RETURN jsonb_build_object('success', false, 'reason', 'terminal_immutable');
  END IF;

  IF p_expected_statuses IS NOT NULL
    AND array_length(p_expected_statuses, 1) > 0
    AND NOT (v_current_status = ANY (p_expected_statuses))
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'invalid_transition',
      'current_status', v_current_status
    );
  END IF;

  UPDATE public.factory_jobs
  SET
    status = p_new_status,
    progress = COALESCE(p_progress, progress),
    current_stage = COALESCE(p_stage, current_stage),
    result = COALESCE(p_result, result),
    error = COALESCE(p_error, error),
    completed_at = CASE
      WHEN p_new_status IN ('completed', 'cancelled', 'failed') THEN COALESCE(completed_at, NOW())
      ELSE completed_at
    END,
    updated_at = NOW()
  WHERE id = p_job_id
    AND (
      p_expected_statuses IS NULL
      OR array_length(p_expected_statuses, 1) IS NULL
      OR status = ANY (p_expected_statuses)
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', v_updated = 1,
    'reason', CASE WHEN v_updated = 1 THEN NULL ELSE 'conditional_update_failed' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.factory_transition_job(UUID, TEXT[], TEXT, SMALLINT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.factory_transition_job(UUID, TEXT[], TEXT, SMALLINT, TEXT, JSONB, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC: factory_check_budget
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.factory_check_budget(
  p_job_id UUID,
  p_capability TEXT,
  p_estimated_cost_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id UUID;
  v_settings JSONB;
  v_per_job_limit NUMERIC;
  v_daily_limit NUMERIC;
  v_spent_today NUMERIC;
  v_spent_job NUMERIC;
  v_remaining NUMERIC;
BEGIN
  SELECT fj.project_id, p.factory_settings
  INTO v_project_id, v_settings
  FROM public.factory_jobs fj
  JOIN public.projects p ON p.id = fj.project_id
  WHERE fj.id = p_job_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'job_not_found',
      'requires_approval', false,
      'remaining_usd', NULL
    );
  END IF;

  v_per_job_limit := NULLIF(v_settings->>'per_job_usd_limit', '')::NUMERIC;
  v_daily_limit := NULLIF(v_settings->>'daily_usd_limit', '')::NUMERIC;

  IF v_per_job_limit IS NULL AND v_daily_limit IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'reason', NULL,
      'requires_approval', false,
      'remaining_usd', NULL
    );
  END IF;

  SELECT COALESCE(SUM(cost_usd), 0)
  INTO v_spent_job
  FROM public.factory_cost_events
  WHERE job_id = p_job_id AND estimated = false;

  IF v_per_job_limit IS NOT NULL THEN
    v_remaining := v_per_job_limit - v_spent_job;
    IF v_spent_job + COALESCE(p_estimated_cost_usd, 0) > v_per_job_limit THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'reason', 'per_job_limit_exceeded',
        'requires_approval', true,
        'remaining_usd', GREATEST(v_remaining, 0)
      );
    END IF;
  END IF;

  IF v_daily_limit IS NOT NULL THEN
    SELECT COALESCE(SUM(ce.cost_usd), 0)
    INTO v_spent_today
    FROM public.factory_cost_events ce
    JOIN public.factory_jobs fj ON fj.id = ce.job_id
    WHERE fj.project_id = v_project_id
      AND ce.estimated = false
      AND ce.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC');

    v_remaining := v_daily_limit - v_spent_today;
    IF v_spent_today + COALESCE(p_estimated_cost_usd, 0) > v_daily_limit THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'reason', 'daily_limit_exceeded',
        'requires_approval', true,
        'remaining_usd', GREATEST(v_remaining, 0)
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', NULL,
    'requires_approval', false,
    'remaining_usd', v_remaining
  );
END;
$$;

REVOKE ALL ON FUNCTION public.factory_check_budget(UUID, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.factory_check_budget(UUID, TEXT, NUMERIC) TO service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.factory_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.factory_job_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.factory_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.factory_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.factory_workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.factory_cost_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS factory_jobs_select ON public.factory_jobs;
CREATE POLICY factory_jobs_select ON public.factory_jobs
  FOR SELECT
  USING (public.has_project_access(auth.uid(), project_id));

DROP POLICY IF EXISTS factory_job_stages_select ON public.factory_job_stages;
CREATE POLICY factory_job_stages_select ON public.factory_job_stages
  FOR SELECT
  USING (public.has_factory_job_access(auth.uid(), job_id));

DROP POLICY IF EXISTS factory_assets_select ON public.factory_assets;
CREATE POLICY factory_assets_select ON public.factory_assets
  FOR SELECT
  USING (public.has_factory_job_access(auth.uid(), job_id));

DROP POLICY IF EXISTS factory_approvals_select ON public.factory_approvals;
CREATE POLICY factory_approvals_select ON public.factory_approvals
  FOR SELECT
  USING (public.has_factory_job_access(auth.uid(), job_id));

DROP POLICY IF EXISTS factory_cost_events_select ON public.factory_cost_events;
CREATE POLICY factory_cost_events_select ON public.factory_cost_events
  FOR SELECT
  USING (public.has_factory_job_access(auth.uid(), job_id));

-- provider_tasks, workflow_events, provider_models: no authenticated policies (service_role only)

GRANT SELECT ON public.factory_job_stages_safe TO authenticated;
GRANT SELECT ON public.factory_assets_safe TO authenticated;
GRANT SELECT ON public.factory_job_detail TO authenticated;

-- ---------------------------------------------------------------------------
-- Realtime publication (additive)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.factory_jobs;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.factory_job_stages;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.factory_assets;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.factory_approvals;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE public.factory_jobs REPLICA IDENTITY FULL;
ALTER TABLE public.factory_job_stages REPLICA IDENTITY FULL;
ALTER TABLE public.factory_assets REPLICA IDENTITY FULL;
ALTER TABLE public.factory_approvals REPLICA IDENTITY FULL;
