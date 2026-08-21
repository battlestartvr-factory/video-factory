-- Restore the Stage 4 parked-waiting contract after Stage 4.5 queue-aware routing.
--
-- Human approval gates intentionally persist as `waiting` with next_action_at NULL and
-- are resumed only by an explicit human-review wake-up. The Stage 4.5 Research Scout
-- migration made finish/watchdog queue-aware but accidentally restored the older rule
-- that every waiting job must have a timer and that every waiting job is watchdog-woken.
-- Preserve queue-aware routing while restoring timerless parked waiting semantics.

CREATE OR REPLACE FUNCTION public.orchestrator_finish_tick(
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_token UUID,
  p_new_status TEXT,
  p_state JSONB DEFAULT NULL,
  p_current_stage TEXT DEFAULT NULL,
  p_progress SMALLINT DEFAULT NULL,
  p_next_action_at TIMESTAMPTZ DEFAULT NULL,
  p_result JSONB DEFAULT NULL,
  p_error JSONB DEFAULT NULL,
  p_state_reason TEXT DEFAULT NULL,
  p_event_type TEXT DEFAULT 'job.transitioned',
  p_event_payload JSONB DEFAULT '{}'::JSONB,
  p_creative_run_id UUID DEFAULT NULL,
  p_enqueue_reason TEXT DEFAULT NULL,
  p_trace_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_job RECORD;
  v_delay_seconds INTEGER := 0;
  v_msg_id BIGINT;
  v_trace_id UUID := COALESCE(p_trace_id, gen_random_uuid());
  v_enqueue_reason TEXT;
  v_effective_next_action TIMESTAMPTZ;
  v_retry_count INTEGER;
  v_queue_name TEXT;
BEGIN
  SELECT status, workflow_kind, lease_owner, lease_token, lease_expires_at, retry_count
  INTO v_job
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'job_not_found');
  END IF;
  IF v_job.status <> 'running'
    OR v_job.lease_owner IS DISTINCT FROM p_worker_id
    OR v_job.lease_token IS DISTINCT FROM p_lease_token
  THEN
    RETURN jsonb_build_object('success', false, 'reason', 'lease_mismatch');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= NOW() THEN
    RETURN jsonb_build_object('success', false, 'reason', 'lease_expired');
  END IF;

  IF p_new_status NOT IN (
    'queued', 'waiting', 'retrying', 'awaiting_approval',
    'completed', 'failed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'invalid running transition target: %', p_new_status;
  END IF;
  IF p_progress IS NOT NULL AND (p_progress < 0 OR p_progress > 100) THEN
    RAISE EXCEPTION 'progress must be between 0 and 100';
  END IF;

  -- Retrying always needs a durable timer. Waiting may intentionally be parked at a
  -- human gate with no timer and is then woken only by an explicit review action.
  IF p_new_status = 'retrying' AND p_next_action_at IS NULL THEN
    RAISE EXCEPTION 'retrying requires next_action_at for durable recovery';
  END IF;

  IF p_new_status = 'queued' THEN
    v_effective_next_action := NOW();
    v_enqueue_reason := COALESCE(NULLIF(trim(p_enqueue_reason), ''), 'next_stage');
  ELSIF p_new_status IN ('waiting', 'retrying') THEN
    v_effective_next_action := p_next_action_at;
    IF p_next_action_at IS NOT NULL THEN
      v_delay_seconds := GREATEST(
        0,
        CEIL(EXTRACT(EPOCH FROM (p_next_action_at - NOW())))::INTEGER
      );
      v_enqueue_reason := COALESCE(
        NULLIF(trim(p_enqueue_reason), ''),
        CASE WHEN p_new_status = 'retrying' THEN 'retry' ELSE 'reconcile' END
      );
    ELSE
      v_enqueue_reason := NULL;
    END IF;
  ELSE
    v_effective_next_action := NULL;
  END IF;

  v_retry_count := v_job.retry_count + CASE WHEN p_new_status = 'retrying' THEN 1 ELSE 0 END;
  v_queue_name := public.orchestrator_queue_name_for_workflow(v_job.workflow_kind);

  UPDATE public.factory_jobs
  SET
    status = p_new_status,
    current_stage = COALESCE(p_current_stage, current_stage),
    progress = COALESCE(p_progress, progress),
    state = COALESCE(p_state, state),
    result = COALESCE(p_result, result),
    error = p_error,
    retry_count = v_retry_count,
    state_reason = p_state_reason,
    next_action_at = v_effective_next_action,
    completed_at = CASE
      WHEN p_new_status IN ('completed', 'failed', 'cancelled') THEN COALESCE(completed_at, NOW())
      ELSE NULL
    END,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL
  WHERE id = p_job_id;

  INSERT INTO public.factory_workflow_events (
    job_id, creative_run_id, event_type, dedupe_key, payload
  ) VALUES (
    p_job_id,
    p_creative_run_id,
    COALESCE(NULLIF(trim(p_event_type), ''), 'job.transitioned'),
    'job:transition:' || p_job_id::TEXT || ':' || p_lease_token::TEXT,
    COALESCE(p_event_payload, '{}'::JSONB) || jsonb_build_object(
      'from_status', 'running',
      'to_status', p_new_status,
      'worker_id', p_worker_id,
      'retry_count', v_retry_count
    )
  );

  -- A parked waiting job has no timer and must not receive a queue message.
  IF p_new_status = 'queued'
    OR (p_new_status IN ('waiting', 'retrying') AND v_effective_next_action IS NOT NULL)
  THEN
    SELECT msg_id
    INTO v_msg_id
    FROM pgmq.send(
      v_queue_name,
      jsonb_build_object(
        'v', 1,
        'job_id', p_job_id,
        'reason', v_enqueue_reason,
        'trace_id', v_trace_id
      ),
      v_delay_seconds
    ) AS msg_id;

    UPDATE public.factory_jobs SET last_enqueued_at = NOW() WHERE id = p_job_id;

    INSERT INTO public.factory_workflow_events (
      job_id, creative_run_id, event_type, dedupe_key, payload
    ) VALUES (
      p_job_id,
      p_creative_run_id,
      'job.enqueued',
      'queue:enqueued:' || v_msg_id::TEXT,
      jsonb_build_object(
        'queue', v_queue_name,
        'queue_msg_id', v_msg_id,
        'reason', v_enqueue_reason,
        'delay_seconds', v_delay_seconds,
        'trace_id', v_trace_id
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', p_new_status,
    'retry_count', v_retry_count,
    'queue_msg_id', v_msg_id,
    'next_action_at', v_effective_next_action,
    'trace_id', CASE WHEN v_msg_id IS NULL THEN NULL ELSE v_trace_id END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_finish_tick(
  UUID, TEXT, UUID, TEXT, JSONB, TEXT, SMALLINT, TIMESTAMPTZ,
  JSONB, JSONB, TEXT, TEXT, JSONB, UUID, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_finish_tick(
  UUID, TEXT, UUID, TEXT, JSONB, TEXT, SMALLINT, TIMESTAMPTZ,
  JSONB, JSONB, TEXT, TEXT, JSONB, UUID, TEXT, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_watchdog_recover(
  p_limit INTEGER DEFAULT 50,
  p_reenqueue_after_seconds INTEGER DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_job RECORD;
  v_msg_id BIGINT;
  v_recovered INTEGER := 0;
  v_stale_leases INTEGER := 0;
  v_queue_name TEXT;
BEGIN
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'limit must be between 1 and 500';
  END IF;
  IF p_reenqueue_after_seconds < 15 OR p_reenqueue_after_seconds > 3600 THEN
    RAISE EXCEPTION 'reenqueue_after_seconds must be between 15 and 3600';
  END IF;

  FOR v_job IN
    SELECT fj.id, fj.status, fj.workflow_kind, fj.lease_token, fj.lease_expires_at
    FROM public.factory_jobs AS fj
    WHERE (
      (
        (fj.status = 'queued' AND (fj.next_action_at IS NULL OR fj.next_action_at <= NOW()))
        OR
        (fj.status IN ('waiting', 'retrying')
          AND fj.next_action_at IS NOT NULL
          AND fj.next_action_at <= NOW())
      )
      AND (
        fj.last_enqueued_at IS NULL
        OR fj.last_enqueued_at <= NOW() - make_interval(secs => p_reenqueue_after_seconds)
      )
    ) OR (
      fj.status = 'running'
      AND fj.lease_expires_at IS NOT NULL
      AND fj.lease_expires_at <= NOW()
    )
    ORDER BY COALESCE(fj.next_action_at, fj.lease_expires_at, fj.created_at), fj.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_job.status = 'running' THEN
      v_stale_leases := v_stale_leases + 1;

      UPDATE public.factory_job_stages
      SET
        status = 'interrupted',
        finished_at = COALESCE(finished_at, NOW()),
        error = COALESCE(
          error,
          jsonb_build_object('code', 'STALE_LEASE', 'message', 'Worker lease expired')
        )
      WHERE job_id = v_job.id
        AND status IN ('running', 'submitted', 'processing');

      UPDATE public.factory_jobs
      SET
        status = 'queued',
        state_reason = 'watchdog_stale_lease',
        next_action_at = NOW(),
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_heartbeat_at = NULL
      WHERE id = v_job.id;
    END IF;

    v_queue_name := public.orchestrator_queue_name_for_workflow(v_job.workflow_kind);

    SELECT msg_id
    INTO v_msg_id
    FROM pgmq.send(
      v_queue_name,
      jsonb_build_object(
        'v', 1,
        'job_id', v_job.id,
        'reason', CASE WHEN v_job.status = 'running' THEN 'stale_lease' ELSE 'watchdog' END,
        'trace_id', gen_random_uuid()
      ),
      0
    ) AS msg_id;

    UPDATE public.factory_jobs
    SET last_enqueued_at = NOW()
    WHERE id = v_job.id;

    INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
    VALUES (
      v_job.id,
      CASE WHEN v_job.status = 'running' THEN 'job.recovered' ELSE 'job.enqueued' END,
      'watchdog:enqueue:' || v_msg_id::TEXT,
      jsonb_build_object(
        'queue', v_queue_name,
        'queue_msg_id', v_msg_id,
        'previous_status', v_job.status,
        'reason', CASE WHEN v_job.status = 'running' THEN 'stale_lease' ELSE 'watchdog' END
      )
    );

    v_recovered := v_recovered + 1;
  END LOOP;

  RETURN jsonb_build_object('recovered', v_recovered, 'stale_leases', v_stale_leases);
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_watchdog_recover(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_watchdog_recover(INTEGER, INTEGER)
  TO service_role;
