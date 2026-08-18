-- Stage 3 / S3-005 failure-injection hardening.
--
-- Split durable provider-task preparation from the one irreversible submit permit.
-- This narrows the unavoidable ambiguity window: if a worker dies after the durable row
-- exists but before claiming the submit permit, recovery may safely continue. Once the
-- permit is claimed (`submitting`), automatic resubmission is never granted again.

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
    'queued',
    v_request_payload,
    v_creative_run_id,
    0,
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
    -- Kept for rolling compatibility. New workers claim the permit through
    -- orchestrator_begin_provider_submit instead of trusting prepare itself.
    'should_submit', false,
    'newly_prepared', v_inserted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_prepare_provider_task(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_prepare_provider_task(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_begin_provider_submit(
  p_provider_task_id UUID,
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.factory_jobs%ROWTYPE;
  v_task public.provider_tasks%ROWTYPE;
  v_should_submit BOOLEAN := false;
BEGIN
  IF p_provider_task_id IS NULL OR p_job_id IS NULL
     OR p_worker_id IS NULL OR length(trim(p_worker_id)) = 0
     OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'provider_task_id, job_id, worker_id and lease_token are required';
  END IF;

  -- Keep the same fencing order used by provider-task preparation: job first, then task.
  SELECT *
  INTO v_job
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found';
  END IF;

  IF v_job.status <> 'running'
     OR v_job.lease_owner IS DISTINCT FROM p_worker_id
     OR v_job.lease_token IS DISTINCT FROM p_lease_token
     OR v_job.lease_expires_at IS NULL
     OR v_job.lease_expires_at <= NOW() THEN
    RAISE EXCEPTION 'active worker lease required for provider submit permit';
  END IF;

  SELECT *
  INTO v_task
  FROM public.provider_tasks
  WHERE id = p_provider_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider task not found';
  END IF;

  IF v_task.job_id IS DISTINCT FROM p_job_id THEN
    RAISE EXCEPTION 'provider task does not belong to claimed job';
  END IF;

  IF v_task.external_task_id IS NULL AND v_task.status = 'queued' THEN
    UPDATE public.provider_tasks
    SET
      status = 'submitting',
      submission_attempts = submission_attempts + 1,
      last_checked_at = NOW()
    WHERE id = p_provider_task_id
    RETURNING * INTO v_task;

    v_should_submit := true;

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
      'provider.submit_started',
      'provider:submit_started:' || v_task.id::TEXT || ':' || v_task.submission_attempts::TEXT,
      jsonb_build_object(
        'provider_task_id', v_task.id,
        'provider', v_task.provider,
        'model', v_task.model,
        'submission_attempts', v_task.submission_attempts
      ),
      v_task.creative_run_id
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'provider_task_id', v_task.id,
    'status', v_task.status,
    'external_task_id', v_task.external_task_id,
    'submission_attempts', v_task.submission_attempts,
    'should_submit', v_should_submit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_begin_provider_submit(UUID, UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_begin_provider_submit(UUID, UUID, TEXT, UUID)
  TO service_role;
