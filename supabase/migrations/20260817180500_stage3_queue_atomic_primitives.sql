-- Stage 3: Durable Core Orchestrator — queue + atomic primitives
-- PGMQ is transport only; public.factory_jobs remains the source of truth.
-- All orchestrator RPCs are service_role-only and keep queue/state mutations transactional.

-- ---------------------------------------------------------------------------
-- Compatibility repair: legacy factory_create_or_get_job does not pass workflow_kind.
-- Existing content-era inserts therefore inherit the legacy workflow identity.
-- ---------------------------------------------------------------------------
ALTER TABLE public.factory_jobs
  ALTER COLUMN workflow_kind SET DEFAULT 'legacy_content';

-- ---------------------------------------------------------------------------
-- Durable Postgres-native queue.
-- Basic pgmq queues use logged tables; do not expose pgmq/pgmq_public to clients.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgmq;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pgmq.list_queues() AS q
    WHERE q.queue_name = 'core_orchestrator_v1'
  ) THEN
    PERFORM pgmq.create('core_orchestrator_v1');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- orchestrator_create_job: idempotent Stage 3 job creation + first queue wake.
-- request_id is the idempotency key. Queue send and job insert share one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_create_job(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_request_id UUID;
  v_user_id UUID;
  v_project_id UUID;
  v_workflow_kind TEXT;
  v_workflow_version INTEGER;
  v_input JSONB;
  v_state JSONB;
  v_trace_id UUID;
  v_job_id UUID;
  v_status TEXT;
  v_msg_id BIGINT;
  v_duplicate BOOLEAN := false;
BEGIN
  v_request_id := NULLIF(payload->>'request_id', '')::UUID;
  v_user_id := NULLIF(payload->>'user_id', '')::UUID;
  v_project_id := NULLIF(payload->>'project_id', '')::UUID;
  v_workflow_kind := NULLIF(trim(payload->>'workflow_kind'), '');
  v_workflow_version := COALESCE(NULLIF(payload->>'workflow_version', '')::INTEGER, 1);
  v_input := COALESCE(payload->'input', '{}'::JSONB);
  v_state := COALESCE(payload->'state', '{}'::JSONB);
  v_trace_id := COALESCE(NULLIF(payload->>'trace_id', '')::UUID, gen_random_uuid());

  IF v_request_id IS NULL OR v_user_id IS NULL OR v_workflow_kind IS NULL THEN
    RAISE EXCEPTION 'invalid orchestrator payload: request_id, user_id and workflow_kind are required';
  END IF;

  IF v_workflow_kind = 'legacy_content' THEN
    RAISE EXCEPTION 'legacy_content must use factory_create_or_get_job';
  END IF;

  IF v_workflow_version <= 0 THEN
    RAISE EXCEPTION 'workflow_version must be positive';
  END IF;

  INSERT INTO public.factory_jobs (
    request_id,
    project_id,
    user_id,
    workflow_kind,
    workflow_version,
    status,
    input,
    state,
    next_action_at
  )
  VALUES (
    v_request_id,
    v_project_id,
    v_user_id,
    v_workflow_kind,
    v_workflow_version,
    'queued',
    v_input,
    v_state,
    NOW()
  )
  ON CONFLICT (request_id) DO NOTHING
  RETURNING id, status INTO v_job_id, v_status;

  IF v_job_id IS NULL THEN
    SELECT fj.id, fj.status
    INTO v_job_id, v_status
    FROM public.factory_jobs AS fj
    WHERE fj.request_id = v_request_id;

    v_duplicate := true;

    RETURN jsonb_build_object(
      'job_id', v_job_id,
      'status', v_status,
      'duplicate', true,
      'queue_msg_id', NULL
    );
  END IF;

  SELECT msg_id
  INTO v_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object(
      'v', 1,
      'job_id', v_job_id,
      'reason', 'created',
      'trace_id', v_trace_id
    ),
    0
  ) AS msg_id;

  UPDATE public.factory_jobs
  SET last_enqueued_at = NOW()
  WHERE id = v_job_id;

  INSERT INTO public.factory_workflow_events (
    job_id,
    event_type,
    dedupe_key,
    payload
  )
  VALUES (
    v_job_id,
    'job.enqueued',
    'queue:enqueued:' || v_msg_id::TEXT,
    jsonb_build_object(
      'queue', 'core_orchestrator_v1',
      'queue_msg_id', v_msg_id,
      'reason', 'created',
      'trace_id', v_trace_id
    )
  );

  RETURN jsonb_build_object(
    'job_id', v_job_id,
    'status', 'queued',
    'duplicate', v_duplicate,
    'queue_msg_id', v_msg_id,
    'trace_id', v_trace_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_create_job(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_create_job(JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- orchestrator_enqueue: transactional wake for an existing due/delayed job.
-- Duplicate messages are allowed; DB state and leases make their processing safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_enqueue(
  p_job_id UUID,
  p_reason TEXT DEFAULT 'manual',
  p_trace_id UUID DEFAULT NULL,
  p_delay_seconds INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_status TEXT;
  v_trace_id UUID := COALESCE(p_trace_id, gen_random_uuid());
  v_msg_id BIGINT;
  v_next_action_at TIMESTAMPTZ;
BEGIN
  IF p_delay_seconds < 0 THEN
    RAISE EXCEPTION 'delay must be nonnegative';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'enqueue reason is required';
  END IF;

  SELECT status
  INTO v_status
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('enqueued', false, 'reason', 'job_not_found');
  END IF;

  IF v_status NOT IN ('queued', 'waiting', 'retrying') THEN
    RETURN jsonb_build_object(
      'enqueued', false,
      'reason', 'job_not_wakeable',
      'status', v_status
    );
  END IF;

  v_next_action_at := NOW() + make_interval(secs => p_delay_seconds);

  SELECT msg_id
  INTO v_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object(
      'v', 1,
      'job_id', p_job_id,
      'reason', p_reason,
      'trace_id', v_trace_id
    ),
    p_delay_seconds
  ) AS msg_id;

  UPDATE public.factory_jobs
  SET
    next_action_at = v_next_action_at,
    last_enqueued_at = NOW()
  WHERE id = p_job_id;

  INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
  VALUES (
    p_job_id,
    'job.enqueued',
    'queue:enqueued:' || v_msg_id::TEXT,
    jsonb_build_object(
      'queue', 'core_orchestrator_v1',
      'queue_msg_id', v_msg_id,
      'reason', p_reason,
      'delay_seconds', p_delay_seconds,
      'trace_id', v_trace_id
    )
  );

  RETURN jsonb_build_object(
    'enqueued', true,
    'queue_msg_id', v_msg_id,
    'trace_id', v_trace_id,
    'next_action_at', v_next_action_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_enqueue(UUID, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_enqueue(UUID, TEXT, UUID, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- Queue receive/ACK wrappers. pgmq itself stays outside the exposed Data API.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_read_queue(
  p_visibility_seconds INTEGER DEFAULT 120,
  p_qty INTEGER DEFAULT 1
)
RETURNS TABLE (
  msg_id BIGINT,
  read_ct INTEGER,
  enqueued_at TIMESTAMPTZ,
  vt TIMESTAMPTZ,
  message JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
BEGIN
  IF p_visibility_seconds < 1 OR p_visibility_seconds > 3600 THEN
    RAISE EXCEPTION 'visibility_seconds must be between 1 and 3600';
  END IF;

  IF p_qty < 1 OR p_qty > 10 THEN
    RAISE EXCEPTION 'qty must be between 1 and 10';
  END IF;

  RETURN QUERY
  SELECT q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message
  FROM pgmq.read('core_orchestrator_v1', p_visibility_seconds, p_qty) AS q;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_read_queue(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_read_queue(INTEGER, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_archive_queue_message(p_msg_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_archived BOOLEAN;
BEGIN
  SELECT pgmq.archive('core_orchestrator_v1', p_msg_id)
  INTO v_archived;
  RETURN COALESCE(v_archived, false);
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_archive_queue_message(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_archive_queue_message(BIGINT) TO service_role;

-- ---------------------------------------------------------------------------
-- orchestrator_claim_job: DB lease + fencing token.
-- An expired token can never be renewed; a new claim always gets a new UUID token.
-- ---------------------------------------------------------------------------
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
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'terminal',
      'status', v_job.status
    );
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
    RETURN jsonb_build_object(
      'claimed', false,
      'reason', 'not_claimable',
      'status', v_job.status
    );
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
    'lease_token', v_token,
    'lease_expires_at', v_expires_at,
    'recovered', v_recovered
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_claim_job(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_claim_job(UUID, TEXT, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- orchestrator_heartbeat_job: renew DB lease and queue visibility together.
-- If the lease already expired, the stale worker is fenced and cannot resurrect it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_heartbeat_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_token UUID,
  p_msg_id BIGINT,
  p_lease_seconds INTEGER DEFAULT 90,
  p_visibility_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_job RECORD;
  v_queue_msg_id BIGINT;
  v_queue_message JSONB;
  v_expires_at TIMESTAMPTZ;
BEGIN
  IF p_lease_seconds < 15 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease_seconds must be between 15 and 900';
  END IF;

  IF p_visibility_seconds < 15 OR p_visibility_seconds > 3600 THEN
    RAISE EXCEPTION 'visibility_seconds must be between 15 and 3600';
  END IF;

  SELECT status, lease_owner, lease_token, lease_expires_at
  INTO v_job
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'job_not_found');
  END IF;

  IF v_job.status <> 'running'
    OR v_job.lease_owner IS DISTINCT FROM p_worker_id
    OR v_job.lease_token IS DISTINCT FROM p_lease_token
  THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'lease_mismatch');
  END IF;

  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= NOW() THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'lease_expired');
  END IF;

  SELECT q.msg_id, q.message
  INTO v_queue_msg_id, v_queue_message
  FROM pgmq.set_vt('core_orchestrator_v1', p_msg_id, p_visibility_seconds) AS q;

  IF v_queue_msg_id IS NULL THEN
    RAISE EXCEPTION 'queue message % not found while renewing lease', p_msg_id;
  END IF;

  IF v_queue_message->>'job_id' IS DISTINCT FROM p_job_id::TEXT THEN
    RAISE EXCEPTION 'queue message % belongs to another job', p_msg_id;
  END IF;

  v_expires_at := NOW() + make_interval(secs => p_lease_seconds);

  UPDATE public.factory_jobs
  SET
    lease_expires_at = v_expires_at,
    last_heartbeat_at = NOW()
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'renewed', true,
    'lease_expires_at', v_expires_at,
    'queue_visibility_seconds', p_visibility_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_heartbeat_job(UUID, TEXT, UUID, BIGINT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_heartbeat_job(UUID, TEXT, UUID, BIGINT, INTEGER, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- orchestrator_finish_tick: fenced state transition + optional delayed wake.
-- The caller must still ACK/archive the delivery after this RPC commits.
-- ---------------------------------------------------------------------------
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
BEGIN
  SELECT status, lease_owner, lease_token, lease_expires_at
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
    v_delay_seconds := GREATEST(
      0,
      CEIL(EXTRACT(EPOCH FROM (p_next_action_at - NOW())))::INTEGER
    );
    v_enqueue_reason := COALESCE(
      NULLIF(trim(p_enqueue_reason), ''),
      CASE WHEN p_new_status = 'retrying' THEN 'retry' ELSE 'reconcile' END
    );
  ELSE
    v_effective_next_action := NULL;
  END IF;

  UPDATE public.factory_jobs
  SET
    status = p_new_status,
    current_stage = COALESCE(p_current_stage, current_stage),
    progress = COALESCE(p_progress, progress),
    state = COALESCE(p_state, state),
    result = COALESCE(p_result, result),
    error = p_error,
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
    job_id,
    creative_run_id,
    event_type,
    dedupe_key,
    payload
  )
  VALUES (
    p_job_id,
    p_creative_run_id,
    COALESCE(NULLIF(trim(p_event_type), ''), 'job.transitioned'),
    'job:transition:' || p_job_id::TEXT || ':' || p_lease_token::TEXT,
    COALESCE(p_event_payload, '{}'::JSONB) || jsonb_build_object(
      'from_status', 'running',
      'to_status', p_new_status,
      'worker_id', p_worker_id
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

    UPDATE public.factory_jobs
    SET last_enqueued_at = NOW()
    WHERE id = p_job_id;

    INSERT INTO public.factory_workflow_events (
      job_id,
      creative_run_id,
      event_type,
      dedupe_key,
      payload
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
