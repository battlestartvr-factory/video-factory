-- Stage 3: Durable Core Orchestrator — retry/recovery/watchdog.
-- Durable retry state belongs to factory_jobs; watchdog reconstructs wake-ups from DB state.

ALTER TABLE public.factory_jobs
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.factory_jobs
  DROP CONSTRAINT IF EXISTS factory_jobs_retry_count_nonnegative;
ALTER TABLE public.factory_jobs
  ADD CONSTRAINT factory_jobs_retry_count_nonnegative CHECK (retry_count >= 0);

-- Claim now exposes the durable retry count to workflow policy.
CREATE OR REPLACE FUNCTION public.orchestrator_claim_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_seconds INTEGER DEFAULT 90
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_token UUID;
  v_expires_at TIMESTAMPTZ;
  v_recovered BOOLEAN;
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker_id is required';
  END IF;

  IF p_lease_seconds < 15 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease_seconds must be between 15 and 900';
  END IF;

  SELECT
    id,
    status,
    workflow_kind,
    workflow_version,
    current_stage,
    state,
    retry_count,
    next_action_at,
    cancel_requested,
    lease_owner,
    lease_token,
    lease_expires_at
  INTO v_job
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'job_not_found');
  END IF;

  IF v_job.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'terminal', 'status', v_job.status);
  END IF;

  IF v_job.cancel_requested THEN
    UPDATE public.factory_jobs
    SET
      status = 'cancelled',
      state_reason = 'cancel_requested',
      completed_at = COALESCE(completed_at, NOW()),
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_heartbeat_at = NULL
    WHERE id = p_job_id;

    INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
    VALUES (
      p_job_id,
      'job.cancelled',
      'job:cancelled:claim:' || p_job_id::TEXT,
      jsonb_build_object('reason', 'cancel_requested')
    )
    ON CONFLICT (dedupe_key) DO NOTHING;

    RETURN jsonb_build_object('claimed', false, 'reason', 'cancel_requested', 'status', 'cancelled');
  END IF;

  IF v_job.status NOT IN ('queued', 'waiting', 'retrying', 'running') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_claimable', 'status', v_job.status);
  END IF;

  IF v_job.next_action_at IS NOT NULL AND v_job.next_action_at > NOW() THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'not_due',
      'status', v_job.status,
      'next_action_at', v_job.next_action_at
    );
  END IF;

  IF v_job.lease_token IS NOT NULL
    AND v_job.lease_expires_at IS NOT NULL
    AND v_job.lease_expires_at > NOW()
  THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'leased',
      'status', v_job.status,
      'lease_expires_at', v_job.lease_expires_at
    );
  END IF;

  v_recovered := v_job.status = 'running' OR v_job.lease_token IS NOT NULL;
  v_token := gen_random_uuid();
  v_expires_at := NOW() + make_interval(secs => p_lease_seconds);

  UPDATE public.factory_jobs
  SET
    status = 'running',
    next_action_at = NULL,
    lease_owner = p_worker_id,
    lease_token = v_token,
    lease_expires_at = v_expires_at,
    last_heartbeat_at = NOW(),
    state_reason = CASE WHEN v_recovered THEN 'recovered_after_stale_lease' ELSE state_reason END
  WHERE id = p_job_id;

  INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
  VALUES (
    p_job_id,
    'job.claimed',
    'job:claimed:' || p_job_id::TEXT || ':' || v_token::TEXT,
    jsonb_build_object(
      'worker_id', p_worker_id,
      'lease_token', v_token,
      'lease_expires_at', v_expires_at,
      'retry_count', v_job.retry_count,
      'recovered', v_recovered
    )
  );

  IF v_recovered THEN
    INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
    VALUES (
      p_job_id,
      'job.recovered',
      'job:recovered:' || p_job_id::TEXT || ':' || v_token::TEXT,
      jsonb_build_object(
        'worker_id', p_worker_id,
        'previous_status', v_job.status,
        'previous_lease_owner', v_job.lease_owner
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'claimed', true,
    'job_id', p_job_id,
    'status', 'running',
    'workflow_kind', v_job.workflow_kind,
    'workflow_version', v_job.workflow_version,
    'current_stage', v_job.current_stage,
    'state', v_job.state,
    'retry_count', v_job.retry_count,
    'lease_token', v_token,
    'lease_expires_at', v_expires_at,
    'recovered', v_recovered
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_claim_job(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_claim_job(UUID, TEXT, INTEGER) TO service_role;

-- Replace finish_tick with the same signature so existing worker callers remain compatible.
-- Entering retrying increments retry_count atomically with error/state and delayed wake-up.
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
BEGIN
  SELECT status, lease_owner, lease_token, lease_expires_at, retry_count
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

  IF p_new_status IN ('waiting', 'retrying') AND p_next_action_at IS NULL THEN
    RAISE EXCEPTION '% requires next_action_at for durable recovery', p_new_status;
  END IF;

  IF p_new_status = 'queued' THEN
    v_effective_next_action := NOW();
    v_enqueue_reason := COALESCE(NULLIF(trim(p_enqueue_reason), ''), 'next_stage');
  ELSIF p_new_status IN ('waiting', 'retrying') THEN
    v_effective_next_action := p_next_action_at;
    v_delay_seconds := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (p_next_action_at - NOW())))::INTEGER);
    v_enqueue_reason := COALESCE(
      NULLIF(trim(p_enqueue_reason), ''),
      CASE WHEN p_new_status = 'retrying' THEN 'retry' ELSE 'reconcile' END
    );
  ELSE
    v_effective_next_action := NULL;
  END IF;

  v_retry_count := v_job.retry_count + CASE WHEN p_new_status = 'retrying' THEN 1 ELSE 0 END;

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
  )
  VALUES (
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

  IF p_new_status IN ('queued', 'waiting', 'retrying') THEN
    SELECT msg_id
    INTO v_msg_id
    FROM pgmq.send(
      'core_orchestrator_v1',
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
    )
    VALUES (
      p_job_id,
      p_creative_run_id,
      'job.enqueued',
      'queue:enqueued:' || v_msg_id::TEXT,
      jsonb_build_object(
        'queue', 'core_orchestrator_v1',
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

-- Watchdog is DB-driven recovery. It can reconstruct wake-ups even if PGMQ messages
-- were lost/archived or all workers were offline. FOR UPDATE SKIP LOCKED avoids
-- fighting an active worker transaction.
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
BEGIN
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'limit must be between 1 and 500';
  END IF;
  IF p_reenqueue_after_seconds < 15 OR p_reenqueue_after_seconds > 3600 THEN
    RAISE EXCEPTION 'reenqueue_after_seconds must be between 15 and 3600';
  END IF;

  FOR v_job IN
    SELECT fj.id, fj.status, fj.lease_token, fj.lease_expires_at
    FROM public.factory_jobs fj
    WHERE
      (
        fj.status IN ('queued', 'waiting', 'retrying')
        AND (fj.next_action_at IS NULL OR fj.next_action_at <= NOW())
        AND (
          fj.last_enqueued_at IS NULL
          OR fj.last_enqueued_at <= NOW() - make_interval(secs => p_reenqueue_after_seconds)
        )
      )
      OR (
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
        error = COALESCE(error, jsonb_build_object('code', 'STALE_LEASE', 'message', 'Worker lease expired'))
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

    SELECT msg_id
    INTO v_msg_id
    FROM pgmq.send(
      'core_orchestrator_v1',
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
        'queue', 'core_orchestrator_v1',
        'queue_msg_id', v_msg_id,
        'previous_status', v_job.status,
        'reason', CASE WHEN v_job.status = 'running' THEN 'stale_lease' ELSE 'watchdog' END
      )
    );

    v_recovered := v_recovered + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'recovered', v_recovered,
    'stale_leases', v_stale_leases
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_watchdog_recover(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_watchdog_recover(INTEGER, INTEGER)
  TO service_role;
