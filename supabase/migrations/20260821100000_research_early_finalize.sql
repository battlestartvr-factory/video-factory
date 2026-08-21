-- Hardening PR4 — explicit "Answer now" boundary for Stage 4.5 research.
-- The root discovery job stays alive. Only unfinished Research Scout children are
-- cancelled/fenced, then the root is made immediately eligible for fan-in/synthesis.

CREATE OR REPLACE FUNCTION public.orchestrator_request_research_early_finalize(
  p_root_job_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root RECORD;
  v_state JSONB;
  v_early JSONB;
  v_research_run_id UUID;
  v_cancelled_scouts INTEGER := 0;
BEGIN
  IF p_root_job_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'root job id and user id are required';
  END IF;

  SELECT fj.id, fj.status, fj.current_stage, fj.state
  INTO v_root
  FROM public.factory_jobs AS fj
  WHERE fj.id = p_root_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'job_not_found');
  END IF;

  IF NOT public.has_factory_job_access(p_user_id, p_root_job_id) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_state := COALESCE(v_root.state, '{}'::jsonb);
  v_early := COALESCE(v_state->'research_early_finalize', '{}'::jsonb);

  IF COALESCE((v_early->>'requested')::BOOLEAN, FALSE) THEN
    RETURN jsonb_build_object(
      'accepted', true,
      'duplicate', true,
      'root_job_id', p_root_job_id,
      'research_run_id', v_state->>'research_run_id',
      'cancelled_scouts', 0,
      'finalization', 'early_finalized'
    );
  END IF;

  IF v_root.status NOT IN ('queued', 'running', 'waiting') THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'job_not_active');
  END IF;

  IF v_root.current_stage <> 'waiting_research_scouts' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'research_not_waiting');
  END IF;

  IF NOT COALESCE((v_early->>'eligible')::BOOLEAN, FALSE) THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'coverage_not_eligible');
  END IF;

  v_research_run_id := NULLIF(v_state->>'research_run_id', '')::UUID;
  IF v_research_run_id IS NULL THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'research_run_missing');
  END IF;

  -- Fence only unfinished Scout jobs. Setting cancel_requested is important for an
  -- already-running Scout: the worker heartbeat observes the same PR1 cancellation
  -- boundary and aborts KIE/Safe Fetch before any later paid/network step can start.
  UPDATE public.factory_jobs AS fj
  SET
    cancel_requested = TRUE,
    cancel_requested_at = COALESCE(fj.cancel_requested_at, NOW()),
    cancel_requested_by = COALESCE(fj.cancel_requested_by, p_user_id),
    cancel_reason = COALESCE(fj.cancel_reason, 'research_early_finalize'),
    status = 'cancelled',
    state_reason = 'research_early_finalized',
    next_action_at = NULL,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    completed_at = COALESCE(fj.completed_at, NOW()),
    error = COALESCE(fj.error, jsonb_build_object(
      'code', 'RESEARCH_EARLY_FINALIZED',
      'message', 'Research Scout cancelled because the user requested an early answer',
      'retryable', false
    ))
  FROM public.research_scout_assignments AS rsa
  WHERE rsa.run_id = v_research_run_id
    AND rsa.factory_job_id = fj.id
    AND fj.status NOT IN ('completed', 'failed', 'cancelled');
  GET DIAGNOSTICS v_cancelled_scouts = ROW_COUNT;

  v_early := v_early || jsonb_build_object(
    'eligible', false,
    'requested', true,
    'requested_at', NOW(),
    'finalization', 'early_finalized'
  );

  UPDATE public.factory_jobs AS fj
  SET
    state = jsonb_set(v_state, '{research_early_finalize}', v_early, true),
    state_reason = 'research_early_finalize_requested',
    next_action_at = NOW(),
    updated_at = NOW()
  WHERE fj.id = p_root_job_id;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload)
  VALUES (
    p_root_job_id,
    'research.early_finalize_requested',
    'research:early_finalize:' || p_root_job_id::TEXT,
    jsonb_build_object(
      'research_run_id', v_research_run_id,
      'requested_by', p_user_id,
      'requested_at', NOW(),
      'cancelled_scouts', v_cancelled_scouts,
      'finalization', 'early_finalized'
    )
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'accepted', true,
    'duplicate', false,
    'root_job_id', p_root_job_id,
    'research_run_id', v_research_run_id,
    'cancelled_scouts', v_cancelled_scouts,
    'finalization', 'early_finalized'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_request_research_early_finalize(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_request_research_early_finalize(UUID, UUID)
  TO service_role;

COMMENT ON FUNCTION public.orchestrator_request_research_early_finalize(UUID, UUID) IS
  'Durably stops unfinished Research Scouts after coverage eligibility and wakes the root run for early-finalized synthesis.';
