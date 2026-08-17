-- Stage 3 / S3-005: durable provider task lifecycle.
--
-- Core safety invariant: a paid provider submission is represented durably before the
-- network side effect happens. Re-observing an existing submission_key never grants a
-- second automatic submit. An accepted-but-not-yet-persisted KIE task can still be
-- correlated by the callback URL's provider_task_id + callback_token.

-- ---------------------------------------------------------------------------
-- Prepare a provider task while the worker still owns the job lease.
-- A fresh row starts directly in `submitting`; only that transaction returns
-- should_submit=true. Existing rows always return should_submit=false.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_prepare_provider_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_worker_id TEXT := NULLIF(trim(payload->>'worker_id'), '');
  v_lease_token UUID := NULLIF(payload->>'lease_token', '')::UUID;
  v_stage TEXT := NULLIF(trim(payload->>'stage'), '');
  v_stage_attempt INTEGER := COALESCE(NULLIF(payload->>'stage_attempt', '')::INTEGER, 1);
  v_provider_model_id UUID := NULLIF(payload->>'provider_model_id', '')::UUID;
  v_provider TEXT := NULLIF(trim(payload->>'provider'), '');
  v_model TEXT := NULLIF(trim(payload->>'model'), '');
  v_submission_key TEXT := NULLIF(trim(payload->>'submission_key'), '');
  v_variant_index INTEGER := COALESCE(NULLIF(payload->>'variant_index', '')::INTEGER, 0);
  v_request_payload JSONB := COALESCE(payload->'request_payload', '{}'::JSONB);
  v_request_payload_hash TEXT := NULLIF(trim(payload->>'request_payload_hash'), '');
  v_creative_run_id UUID := NULLIF(payload->>'creative_run_id', '')::UUID;
  v_job public.factory_jobs%ROWTYPE;
  v_stage_id UUID;
  v_stage_status TEXT;
  v_task public.provider_tasks%ROWTYPE;
  v_inserted BOOLEAN := false;
BEGIN
  IF v_job_id IS NULL OR v_worker_id IS NULL OR v_lease_token IS NULL THEN
    RAISE EXCEPTION 'job_id, worker_id and lease_token are required';
  END IF;

  IF v_stage IS NULL OR v_provider IS NULL OR v_model IS NULL OR v_submission_key IS NULL THEN
    RAISE EXCEPTION 'stage, provider, model and submission_key are required';
  END IF;

  IF v_stage_attempt <= 0 OR v_variant_index < 0 THEN
    RAISE EXCEPTION 'stage_attempt must be positive and variant_index nonnegative';
  END IF;

  IF v_request_payload_hash IS NULL THEN
    RAISE EXCEPTION 'request_payload_hash is required';
  END IF;

  SELECT *
  INTO v_job
  FROM public.factory_jobs
  WHERE id = v_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found';
  END IF;

  IF v_job.status <> 'running'
     OR v_job.lease_owner IS DISTINCT FROM v_worker_id
     OR v_job.lease_token IS DISTINCT FROM v_lease_token
     OR v_job.lease_expires_at IS NULL
     OR v_job.lease_expires_at <= NOW() THEN
    RAISE EXCEPTION 'active worker lease required for provider task prepare';
  END IF;

  INSERT INTO public.factory_job_stages (
    job_id,
    stage,
    status,
    attempt,
    started_at,
    input,
    creative_run_id
  )
  VALUES (
    v_job_id,
    v_stage,
    'running',
    v_stage_attempt,
    NOW(),
    jsonb_build_object('provider_submission_key', v_submission_key),
    v_creative_run_id
  )
  ON CONFLICT (job_id, stage, attempt) DO NOTHING
  RETURNING id, status INTO v_stage_id, v_stage_status;

  IF v_stage_id IS NULL THEN
    SELECT id, status
    INTO v_stage_id, v_stage_status
    FROM public.factory_job_stages
    WHERE job_id = v_job_id
      AND stage = v_stage
      AND attempt = v_stage_attempt
    FOR UPDATE;
  END IF;

  IF v_stage_id IS NULL THEN
    RAISE EXCEPTION 'failed to resolve provider stage';
  END IF;

  IF v_stage_status IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'provider stage is already terminal: %', v_stage_status;
  END IF;

  INSERT INTO public.provider_tasks (
    job_id,
    stage_id,
    provider_model_id,
    provider,
    model,
    submission_key,
    variant_index,
    status,
    request_payload,
    creative_run_id,
    submission_attempts,
    callback_token,
    request_payload_hash
  )
  VALUES (
    v_job_id,
    v_stage_id,
    v_provider_model_id,
    v_provider,
    v_model,
    v_submission_key,
    v_variant_index,
    'submitting',
    v_request_payload,
    v_creative_run_id,
    1,
    gen_random_uuid(),
    v_request_payload_hash
  )
  ON CONFLICT (submission_key) DO NOTHING
  RETURNING * INTO v_task;

  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT *
    INTO v_task
    FROM public.provider_tasks
    WHERE submission_key = v_submission_key
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'provider task disappeared after submission_key conflict';
    END IF;

    IF v_task.job_id IS DISTINCT FROM v_job_id
       OR v_task.stage_id IS DISTINCT FROM v_stage_id
       OR v_task.provider IS DISTINCT FROM v_provider
       OR v_task.model IS DISTINCT FROM v_model
       OR v_task.variant_index IS DISTINCT FROM v_variant_index
       OR v_task.request_payload_hash IS DISTINCT FROM v_request_payload_hash THEN
      RAISE EXCEPTION 'submission_key collision with different provider request';
    END IF;

    IF v_task.callback_token IS NULL THEN
      RAISE EXCEPTION 'existing provider task has no callback token; manual reconciliation required';
    END IF;
  ELSE
    INSERT INTO public.factory_workflow_events (
      job_id,
      stage_id,
      event_type,
      dedupe_key,
      payload,
      creative_run_id
    )
    VALUES (
      v_job_id,
      v_stage_id,
      'provider.submission_prepared',
      'provider:prepared:' || v_task.id::TEXT,
      jsonb_build_object(
        'provider_task_id', v_task.id,
        'provider', v_provider,
        'model', v_model,
        'submission_key', v_submission_key,
        'request_payload_hash', v_request_payload_hash
      ),
      v_creative_run_id
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'provider_task_id', v_task.id,
    'stage_id', v_task.stage_id,
    'status', v_task.status,
    'external_task_id', v_task.external_task_id,
    'callback_token', v_task.callback_token,
    'submission_attempts', v_task.submission_attempts,
    'should_submit', v_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_prepare_provider_task(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_prepare_provider_task(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Persist the provider task id after createTask returns.
-- This intentionally does not require the worker lease: once an external side effect
-- happened, recording its identity is always safer than dropping it because a lease expired.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_record_provider_submit(
  p_provider_task_id UUID,
  p_external_task_id TEXT,
  p_submit_payload JSONB DEFAULT '{}'::JSONB,
  p_next_check_at TIMESTAMPTZ DEFAULT NULL,
  p_response_payload_hash TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.provider_tasks%ROWTYPE;
  v_next_status TEXT;
BEGIN
  IF p_provider_task_id IS NULL OR p_external_task_id IS NULL OR length(trim(p_external_task_id)) = 0 THEN
    RAISE EXCEPTION 'provider_task_id and external_task_id are required';
  END IF;

  SELECT *
  INTO v_task
  FROM public.provider_tasks
  WHERE id = p_provider_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider task not found';
  END IF;

  IF v_task.external_task_id IS NOT NULL
     AND v_task.external_task_id IS DISTINCT FROM p_external_task_id THEN
    RAISE EXCEPTION 'provider task already has a different external_task_id';
  END IF;

  v_next_status := CASE
    WHEN v_task.status = 'submitting' THEN 'submitted'
    ELSE v_task.status
  END;

  UPDATE public.provider_tasks
  SET
    external_task_id = COALESCE(external_task_id, p_external_task_id),
    status = v_next_status,
    response_payload = COALESCE(response_payload, '{}'::JSONB)
      || jsonb_build_object('submit', COALESCE(p_submit_payload, '{}'::JSONB)),
    response_payload_hash = COALESCE(NULLIF(trim(p_response_payload_hash), ''), response_payload_hash),
    next_check_at = CASE
      WHEN v_next_status IN ('succeeded', 'failed', 'cancelled') THEN NULL
      ELSE COALESCE(p_next_check_at, NOW() + INTERVAL '3 seconds')
    END
  WHERE id = p_provider_task_id
  RETURNING * INTO v_task;

  UPDATE public.factory_job_stages
  SET status = CASE
    WHEN status IN ('queued', 'running') THEN 'submitted'
    ELSE status
  END
  WHERE id = v_task.stage_id;

  INSERT INTO public.factory_workflow_events (
    job_id,
    stage_id,
    event_type,
    dedupe_key,
    payload,
    creative_run_id
  )
  VALUES (
    v_task.job_id,
    v_task.stage_id,
    'provider.submitted',
    'provider:submitted:' || v_task.id::TEXT || ':' || p_external_task_id,
    jsonb_build_object(
      'provider_task_id', v_task.id,
      'provider', v_task.provider,
      'model', v_task.model,
      'external_task_id', p_external_task_id
    ),
    v_task.creative_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'provider_task_id', v_task.id,
    'status', v_task.status,
    'external_task_id', v_task.external_task_id,
    'next_check_at', v_task.next_check_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_provider_submit(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_provider_submit(UUID, TEXT, JSONB, TIMESTAMPTZ, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Record a verified callback and wake a durable job. The callback is a signal, not
-- the canonical completion authority: the worker reconciles against recordInfo.
-- Lock order is job -> provider_task to stay compatible with prepare_provider_task.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_record_provider_callback(
  p_provider_task_id UUID,
  p_callback_token UUID,
  p_external_task_id TEXT,
  p_callback_payload JSONB DEFAULT '{}'::JSONB,
  p_trace_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_job_id UUID;
  v_job_status TEXT;
  v_task public.provider_tasks%ROWTYPE;
  v_trace_id UUID := COALESCE(p_trace_id, gen_random_uuid());
  v_msg_id BIGINT;
  v_woke_job BOOLEAN := false;
BEGIN
  IF p_provider_task_id IS NULL OR p_callback_token IS NULL THEN
    RAISE EXCEPTION 'provider_task_id and callback_token are required';
  END IF;

  IF p_external_task_id IS NULL OR length(trim(p_external_task_id)) = 0 THEN
    RAISE EXCEPTION 'external_task_id is required';
  END IF;

  SELECT job_id
  INTO v_job_id
  FROM public.provider_tasks
  WHERE id = p_provider_task_id;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'provider task not found';
  END IF;

  SELECT status
  INTO v_job_status
  FROM public.factory_jobs
  WHERE id = v_job_id
  FOR UPDATE;

  SELECT *
  INTO v_task
  FROM public.provider_tasks
  WHERE id = p_provider_task_id
  FOR UPDATE;

  IF NOT FOUND OR v_task.callback_token IS DISTINCT FROM p_callback_token THEN
    RAISE EXCEPTION 'invalid provider callback correlation token';
  END IF;

  IF v_task.external_task_id IS NOT NULL
     AND v_task.external_task_id IS DISTINCT FROM p_external_task_id THEN
    RAISE EXCEPTION 'provider callback external_task_id mismatch';
  END IF;

  UPDATE public.provider_tasks
  SET
    external_task_id = COALESCE(external_task_id, p_external_task_id),
    status = CASE
      WHEN status IN ('succeeded', 'failed', 'cancelled') THEN status
      ELSE 'reconciling'
    END,
    response_payload = COALESCE(response_payload, '{}'::JSONB)
      || jsonb_build_object('callback', COALESCE(p_callback_payload, '{}'::JSONB)),
    callback_received_at = NOW(),
    next_check_at = CASE
      WHEN status IN ('succeeded', 'failed', 'cancelled') THEN NULL
      ELSE NOW()
    END
  WHERE id = p_provider_task_id
  RETURNING * INTO v_task;

  UPDATE public.factory_job_stages
  SET status = CASE
    WHEN status IN ('queued', 'running', 'submitted') THEN 'processing'
    ELSE status
  END
  WHERE id = v_task.stage_id;

  INSERT INTO public.factory_workflow_events (
    job_id,
    stage_id,
    event_type,
    dedupe_key,
    payload,
    creative_run_id
  )
  VALUES (
    v_task.job_id,
    v_task.stage_id,
    'provider.callback_received',
    'provider:callback:' || v_task.id::TEXT,
    jsonb_build_object(
      'provider_task_id', v_task.id,
      'provider', v_task.provider,
      'external_task_id', p_external_task_id,
      'trace_id', v_trace_id
    ),
    v_task.creative_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  IF v_job_status IN ('queued', 'waiting', 'retrying') THEN
    SELECT msg_id
    INTO v_msg_id
    FROM pgmq.send(
      'core_orchestrator_v1',
      jsonb_build_object(
        'v', 1,
        'job_id', v_task.job_id,
        'reason', 'provider_callback',
        'trace_id', v_trace_id
      ),
      0
    ) AS msg_id;

    UPDATE public.factory_jobs
    SET
      next_action_at = NOW(),
      last_enqueued_at = NOW()
    WHERE id = v_task.job_id;

    INSERT INTO public.factory_workflow_events (
      job_id,
      event_type,
      dedupe_key,
      payload,
      creative_run_id
    )
    VALUES (
      v_task.job_id,
      'job.enqueued',
      'queue:enqueued:' || v_msg_id::TEXT,
      jsonb_build_object(
        'queue', 'core_orchestrator_v1',
        'queue_msg_id', v_msg_id,
        'reason', 'provider_callback',
        'provider_task_id', v_task.id,
        'trace_id', v_trace_id
      ),
      v_task.creative_run_id
    );

    v_woke_job := true;
  END IF;

  RETURN jsonb_build_object(
    'accepted', true,
    'provider_task_id', v_task.id,
    'status', v_task.status,
    'external_task_id', v_task.external_task_id,
    'job_status', v_job_status,
    'woke_job', v_woke_job,
    'queue_msg_id', v_msg_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_provider_callback(UUID, UUID, TEXT, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_provider_callback(UUID, UUID, TEXT, JSONB, UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Persist the canonical KIE Market recordInfo observation. Status transitions are
-- monotonic at terminal states; callbacks can only move a task to reconciling.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_record_provider_status(
  p_provider_task_id UUID,
  p_external_task_id TEXT,
  p_provider_state TEXT,
  p_status_payload JSONB DEFAULT '{}'::JSONB,
  p_next_check_at TIMESTAMPTZ DEFAULT NULL,
  p_credits_used NUMERIC DEFAULT NULL,
  p_response_payload_hash TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.provider_tasks%ROWTYPE;
  v_normalized_state TEXT := lower(trim(COALESCE(p_provider_state, '')));
  v_target_status TEXT;
  v_effective_status TEXT;
  v_payload_hash TEXT;
BEGIN
  IF p_provider_task_id IS NULL OR p_external_task_id IS NULL OR length(trim(p_external_task_id)) = 0 THEN
    RAISE EXCEPTION 'provider_task_id and external_task_id are required';
  END IF;

  v_target_status := CASE v_normalized_state
    WHEN 'waiting' THEN 'submitted'
    WHEN 'queuing' THEN 'processing'
    WHEN 'generating' THEN 'processing'
    WHEN 'success' THEN 'succeeded'
    WHEN 'fail' THEN 'failed'
    ELSE NULL
  END;

  IF v_target_status IS NULL THEN
    RAISE EXCEPTION 'unsupported provider state: %', p_provider_state;
  END IF;

  SELECT *
  INTO v_task
  FROM public.provider_tasks
  WHERE id = p_provider_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider task not found';
  END IF;

  IF v_task.external_task_id IS NOT NULL
     AND v_task.external_task_id IS DISTINCT FROM p_external_task_id THEN
    RAISE EXCEPTION 'provider status external_task_id mismatch';
  END IF;

  v_effective_status := CASE
    WHEN v_task.status IN ('succeeded', 'failed', 'cancelled') THEN v_task.status
    WHEN v_task.status = 'processing' AND v_target_status = 'submitted' THEN 'processing'
    ELSE v_target_status
  END;

  v_payload_hash := COALESCE(
    NULLIF(trim(p_response_payload_hash), ''),
    md5(COALESCE(p_status_payload, '{}'::JSONB)::TEXT)
  );

  UPDATE public.provider_tasks
  SET
    external_task_id = COALESCE(external_task_id, p_external_task_id),
    status = v_effective_status,
    response_payload = COALESCE(response_payload, '{}'::JSONB)
      || jsonb_build_object('status', COALESCE(p_status_payload, '{}'::JSONB)),
    response_payload_hash = v_payload_hash,
    credits_used = COALESCE(p_credits_used, credits_used),
    last_checked_at = NOW(),
    next_check_at = CASE
      WHEN v_effective_status IN ('succeeded', 'failed', 'cancelled') THEN NULL
      ELSE COALESCE(p_next_check_at, NOW() + INTERVAL '3 seconds')
    END,
    error = CASE
      WHEN v_effective_status = 'failed' THEN jsonb_strip_nulls(jsonb_build_object(
        'provider_state', v_normalized_state,
        'code', COALESCE(
          p_status_payload #>> '{data,failCode}',
          p_status_payload ->> 'failCode'
        ),
        'message', COALESCE(
          p_status_payload #>> '{data,failMsg}',
          p_status_payload ->> 'failMsg'
        )
      ))
      ELSE error
    END
  WHERE id = p_provider_task_id
  RETURNING * INTO v_task;

  UPDATE public.factory_job_stages
  SET
    status = CASE
      WHEN v_task.status = 'submitted' AND status IN ('queued', 'running') THEN 'submitted'
      WHEN v_task.status = 'processing' AND status IN ('queued', 'running', 'submitted') THEN 'processing'
      WHEN v_task.status = 'succeeded' AND status NOT IN ('failed', 'cancelled') THEN 'succeeded'
      WHEN v_task.status = 'failed' AND status NOT IN ('succeeded', 'cancelled') THEN 'failed'
      WHEN v_task.status = 'cancelled' AND status NOT IN ('succeeded', 'failed') THEN 'cancelled'
      ELSE status
    END,
    finished_at = CASE
      WHEN v_task.status IN ('succeeded', 'failed', 'cancelled') THEN COALESCE(finished_at, NOW())
      ELSE finished_at
    END
  WHERE id = v_task.stage_id;

  INSERT INTO public.factory_workflow_events (
    job_id,
    stage_id,
    event_type,
    dedupe_key,
    payload,
    creative_run_id
  )
  VALUES (
    v_task.job_id,
    v_task.stage_id,
    'provider.status_observed',
    'provider:status:' || v_task.id::TEXT || ':' || v_normalized_state || ':' || v_payload_hash,
    jsonb_build_object(
      'provider_task_id', v_task.id,
      'provider', v_task.provider,
      'model', v_task.model,
      'external_task_id', p_external_task_id,
      'provider_state', v_normalized_state,
      'status', v_task.status,
      'credits_used', v_task.credits_used
    ),
    v_task.creative_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'provider_task_id', v_task.id,
    'status', v_task.status,
    'external_task_id', v_task.external_task_id,
    'credits_used', v_task.credits_used,
    'next_check_at', v_task.next_check_at,
    'error', v_task.error
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_provider_status(UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ, NUMERIC, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_provider_status(UUID, TEXT, TEXT, JSONB, TIMESTAMPTZ, NUMERIC, TEXT)
  TO service_role;
