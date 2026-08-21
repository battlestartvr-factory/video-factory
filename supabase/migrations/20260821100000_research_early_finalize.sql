-- Hardening PR4 — explicit "Answer now" boundary for Stage 4.5 research.
-- The root discovery job stays alive. The user-facing RPC re-validates the durable
-- coverage gate through the scoped Research Council finalizer, which cancels/fences
-- only unfinished Scout children and then wakes the root for immediate synthesis.

CREATE OR REPLACE FUNCTION public.orchestrator_request_research_early_finalize(
  p_root_job_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_root RECORD;
  v_state JSONB;
  v_early JSONB;
  v_research_run_id UUID;
  v_finalize JSONB;
  v_cancelled_scouts INTEGER := 0;
  v_queue_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
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

  -- Never trust the UI/root-state eligibility marker as the final authority. The
  -- scoped DB finalizer locks the Research run + child jobs, re-checks completed
  -- Scouts/evidence/critical-role coverage, terminalizes only unfinished Scouts,
  -- cancels their active stages/provider reconciliation, records durable metadata,
  -- and installs the late-evidence/report fence. The root job is not cancelled.
  v_finalize := public.research_early_finalize_scout_fanout(v_research_run_id);

  IF COALESCE((v_finalize->>'finalized')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'accepted', false,
      'reason', COALESCE(v_finalize->>'reason', 'coverage_not_eligible'),
      'research_run_id', v_research_run_id,
      'finalization', 'full'
    );
  END IF;

  v_cancelled_scouts := COALESCE(
    NULLIF(v_finalize->>'terminalized_scouts', '')::INTEGER,
    0
  );

  v_early := v_early || jsonb_build_object(
    'eligible', false,
    'requested', true,
    'requested_at', NOW(),
    'requested_by', p_user_id,
    'finalization', 'early_finalized'
  );

  -- The root remains executable, but an already-running waiting-stage worker may
  -- still hold a stale copy of state from immediately before the user's click.
  -- Revoke that lease and requeue the same root stage so its stale finishTick is
  -- rejected by the normal lease-token fence instead of overwriting requested=true.
  UPDATE public.factory_jobs AS fj
  SET
    status = 'queued',
    state = jsonb_set(v_state, '{research_early_finalize}', v_early, true),
    state_reason = 'research_early_finalize_requested',
    next_action_at = NOW(),
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
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

  -- Do not wait for the watchdog's reenqueue-after window. Publish an immediate
  -- wake-up in the same transaction as the durable boundary. A previously queued
  -- message is harmless: orchestrator_claim_job serializes on the job row and the
  -- lease token prevents concurrent/stale commits.
  SELECT msg_id
  INTO v_queue_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object(
      'v', 1,
      'job_id', p_root_job_id,
      'reason', 'research_early_finalize',
      'trace_id', v_trace_id
    ),
    0
  ) AS msg_id;

  UPDATE public.factory_jobs AS fj
  SET last_enqueued_at = NOW()
  WHERE fj.id = p_root_job_id;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload)
  VALUES (
    p_root_job_id,
    'job.enqueued',
    'queue:enqueued:' || v_queue_msg_id::TEXT,
    jsonb_build_object(
      'queue', 'core_orchestrator_v1',
      'queue_msg_id', v_queue_msg_id,
      'reason', 'research_early_finalize',
      'delay_seconds', 0,
      'trace_id', v_trace_id
    )
  );

  RETURN jsonb_build_object(
    'accepted', true,
    'duplicate', COALESCE((v_finalize->>'duplicate')::BOOLEAN, FALSE),
    'root_job_id', p_root_job_id,
    'research_run_id', v_research_run_id,
    'cancelled_scouts', v_cancelled_scouts,
    'queue_msg_id', v_queue_msg_id,
    'finalization', 'early_finalized'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_request_research_early_finalize(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_request_research_early_finalize(UUID, UUID)
  TO service_role;

COMMENT ON FUNCTION public.orchestrator_request_research_early_finalize(UUID, UUID) IS
  'User-authorized Answer-now boundary: revalidates coverage, scoped-cancels/fences unfinished Research Scouts, fences a stale root waiting-stage lease, and atomically wakes the root run for early-finalized synthesis.';
