-- Hardening PR1 — Real Stop / Cancellation.
-- User Stop is a durable, idempotent terminal transition. It must fence active leases,
-- cascade through Game Discovery descendants, and prevent any later retry/wake from
-- turning a cancelled run back into work.

ALTER TABLE public.factory_jobs
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_requested_by UUID,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_factory_jobs_cancel_requested
  ON public.factory_jobs(cancel_requested_at)
  WHERE cancel_requested = TRUE;

-- Read by active workers on a short interval. This is deliberately service-role only;
-- browser clients cancel through the authenticated application endpoint instead.
CREATE OR REPLACE FUNCTION public.orchestrator_get_cancel_state(p_job_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN fj.id IS NULL THEN jsonb_build_object(
      'found', false,
      'cancelled', false
    )
    ELSE jsonb_build_object(
      'found', true,
      'status', fj.status,
      'cancel_requested', fj.cancel_requested,
      'cancelled', fj.status = 'cancelled' OR fj.cancel_requested,
      'cancel_requested_at', fj.cancel_requested_at,
      'cancel_reason', fj.cancel_reason
    )
  END
  FROM (SELECT p_job_id AS id) AS requested
  LEFT JOIN public.factory_jobs AS fj ON fj.id = requested.id;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_cancel_state(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_cancel_state(UUID)
  TO service_role;

-- Cancel one root factory job and every durable descendant that belongs to the same
-- creative-run tree / Stage 4.5 fan-out. Existing terminal work is never rewritten.
CREATE OR REPLACE FUNCTION public.orchestrator_request_cancel(
  p_root_job_id UUID,
  p_user_id UUID,
  p_reason TEXT DEFAULT 'user_stop'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root RECORD;
  v_reason TEXT := LEFT(COALESCE(NULLIF(trim(p_reason), ''), 'user_stop'), 500);
  v_cancelled_jobs INTEGER := 0;
  v_cancelled_runs INTEGER := 0;
  v_cancelled_research_runs INTEGER := 0;
  v_cancelled_stages INTEGER := 0;
  v_cancelled_provider_tasks INTEGER := 0;
BEGIN
  IF p_root_job_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'root job id and user id are required';
  END IF;

  SELECT fj.id, fj.user_id, fj.project_id, fj.status, fj.cancel_requested
  INTO v_root
  FROM public.factory_jobs AS fj
  WHERE fj.id = p_root_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'job_not_found');
  END IF;

  IF NOT public.has_factory_job_access(p_user_id, p_root_job_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- A temp table gives every subsequent update the exact same fenced job set.
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.cancel_job_ids (
    job_id UUID PRIMARY KEY
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.cancel_job_ids;

  INSERT INTO pg_temp.cancel_job_ids(job_id)
  WITH RECURSIVE root_runs AS (
    SELECT cr.id, cr.factory_job_id
    FROM public.creative_runs AS cr
    WHERE cr.factory_job_id = p_root_job_id
    UNION ALL
    SELECT child.id, child.factory_job_id
    FROM public.creative_runs AS child
    JOIN root_runs AS parent ON child.parent_run_id = parent.id
  ), gathered AS (
    SELECT p_root_job_id AS job_id
    UNION
    SELECT rr.factory_job_id
    FROM root_runs AS rr
    WHERE rr.factory_job_id IS NOT NULL
    UNION
    SELECT fj.id
    FROM public.factory_jobs AS fj
    WHERE fj.input->>'root_factory_job_id' = p_root_job_id::TEXT
    UNION
    SELECT rsa.factory_job_id
    FROM public.research_runs AS research
    JOIN public.research_scout_assignments AS rsa ON rsa.run_id = research.id
    WHERE research.factory_job_id = p_root_job_id
    UNION
    SELECT cca.factory_job_id
    FROM public.research_runs AS research
    JOIN public.concept_council_assignments AS cca ON cca.run_id = research.id
    WHERE research.factory_job_id = p_root_job_id
  )
  SELECT job_id FROM gathered WHERE job_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  UPDATE public.factory_jobs AS fj
  SET
    cancel_requested = TRUE,
    cancel_requested_at = COALESCE(fj.cancel_requested_at, NOW()),
    cancel_requested_by = COALESCE(fj.cancel_requested_by, p_user_id),
    cancel_reason = COALESCE(fj.cancel_reason, v_reason),
    status = 'cancelled',
    state_reason = 'user_cancelled',
    next_action_at = NULL,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    completed_at = COALESCE(fj.completed_at, NOW()),
    error = COALESCE(fj.error, jsonb_build_object(
      'code', 'USER_CANCELLED',
      'message', 'Cancelled by user',
      'retryable', false
    ))
  WHERE fj.id IN (SELECT job_id FROM pg_temp.cancel_job_ids)
    AND fj.status NOT IN ('completed', 'failed', 'cancelled');
  GET DIAGNOSTICS v_cancelled_jobs = ROW_COUNT;

  -- Mark active stage/provider bookkeeping terminal so local reconciliation cannot keep
  -- presenting a cancelled discovery as live work. Remote providers may have already
  -- accepted an irreversible media task; cancellation prevents further local orchestration.
  UPDATE public.factory_job_stages AS stage
  SET
    status = 'cancelled',
    finished_at = COALESCE(stage.finished_at, NOW())
  WHERE stage.job_id IN (SELECT job_id FROM pg_temp.cancel_job_ids)
    AND stage.status NOT IN ('succeeded', 'failed', 'cancelled');
  GET DIAGNOSTICS v_cancelled_stages = ROW_COUNT;

  UPDATE public.provider_tasks AS task
  SET
    status = 'cancelled',
    next_check_at = NULL,
    error = COALESCE(task.error, jsonb_build_object(
      'code', 'USER_CANCELLED',
      'message', 'Local provider reconciliation cancelled by user'
    ))
  WHERE task.job_id IN (SELECT job_id FROM pg_temp.cancel_job_ids)
    AND task.status NOT IN ('succeeded', 'failed', 'cancelled');
  GET DIAGNOSTICS v_cancelled_provider_tasks = ROW_COUNT;

  UPDATE public.creative_runs AS cr
  SET
    status = 'cancelled',
    completed_at = COALESCE(cr.completed_at, NOW()),
    error_code = COALESCE(cr.error_code, 'USER_CANCELLED'),
    error_message = COALESCE(cr.error_message, 'Cancelled by user')
  WHERE cr.factory_job_id IN (SELECT job_id FROM pg_temp.cancel_job_ids)
    AND cr.status NOT IN ('completed', 'failed', 'cancelled');
  GET DIAGNOSTICS v_cancelled_runs = ROW_COUNT;

  UPDATE public.research_runs AS rr
  SET
    status = 'cancelled',
    completed_at = COALESCE(rr.completed_at, NOW()),
    error = COALESCE(rr.error, jsonb_build_object(
      'code', 'USER_CANCELLED',
      'message', 'Research cancelled by user'
    ))
  WHERE rr.factory_job_id = p_root_job_id
    AND rr.status NOT IN ('completed', 'failed', 'cancelled');
  GET DIAGNOSTICS v_cancelled_research_runs = ROW_COUNT;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload)
  SELECT
    ids.job_id,
    'job.cancelled',
    'job:cancelled:user:' || ids.job_id::TEXT,
    jsonb_build_object(
      'reason', v_reason,
      'requested_by', p_user_id,
      'root_job_id', p_root_job_id,
      'requested_at', NOW()
    )
  FROM pg_temp.cancel_job_ids AS ids
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'cancelled', true,
    'already_terminal', v_root.status IN ('completed', 'failed', 'cancelled'),
    'root_job_id', p_root_job_id,
    'cancelled_jobs', v_cancelled_jobs,
    'cancelled_creative_runs', v_cancelled_runs,
    'cancelled_research_runs', v_cancelled_research_runs,
    'cancelled_stages', v_cancelled_stages,
    'cancelled_provider_tasks', v_cancelled_provider_tasks,
    'reason', v_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_request_cancel(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_request_cancel(UUID, UUID, TEXT)
  TO service_role;

COMMENT ON FUNCTION public.orchestrator_request_cancel(UUID, UUID, TEXT) IS
  'Hard user-stop boundary: idempotently fences the root Game Discovery job and all durable descendants.';
