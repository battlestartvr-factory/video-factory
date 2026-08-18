-- Stage 3 / S3-005 hardening: a definitive createTask rejection must fail the
-- provider task and its linked image generation in one transaction. This closes the
-- crash window between those durable updates without ever granting another paid POST.

CREATE OR REPLACE FUNCTION public.orchestrator_record_provider_submit_failure(
  p_provider_task_id UUID,
  p_error JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.provider_tasks%ROWTYPE;
  v_generation_id UUID;
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  SELECT *
  INTO v_task
  FROM public.provider_tasks
  WHERE id = p_provider_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider task not found';
  END IF;

  IF v_task.external_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'cannot mark submitted provider task as submit failure';
  END IF;

  v_error_code := COALESCE(NULLIF(p_error->>'code', ''), 'KIE_SUBMIT_REJECTED');
  v_error_message := COALESCE(NULLIF(p_error->>'message', ''), 'KIE createTask was rejected');

  IF v_task.status NOT IN ('failed', 'cancelled') THEN
    UPDATE public.provider_tasks
    SET
      status = 'failed',
      error = COALESCE(p_error, '{}'::JSONB),
      next_check_at = NULL,
      last_checked_at = NOW()
    WHERE id = p_provider_task_id
    RETURNING * INTO v_task;

    UPDATE public.factory_job_stages
    SET
      status = CASE WHEN status = 'cancelled' THEN status ELSE 'failed' END,
      error = COALESCE(p_error, '{}'::JSONB),
      finished_at = COALESCE(finished_at, NOW())
    WHERE id = v_task.stage_id;
  END IF;

  -- generation_image@1 linkage is optional so this RPC remains reusable by future
  -- provider workflows. If linked, failure propagation is part of this transaction.
  SELECT g.id
  INTO v_generation_id
  FROM public.generations AS g
  WHERE g.factory_job_id = v_task.job_id
    AND g.type = 'image';

  IF v_generation_id IS NOT NULL THEN
    UPDATE public.generations
    SET
      status = 'failed',
      error_message = v_error_message,
      completed_at = COALESCE(completed_at, NOW())
    WHERE id = v_generation_id
      AND status NOT IN ('completed', 'cancelled');

    UPDATE public.agent_actions
    SET
      status = 'failed',
      error_code = v_error_code,
      error_message = v_error_message,
      finished_at = COALESCE(finished_at, NOW())
    WHERE generation_id = v_generation_id
      AND action_type = 'generate_image'
      AND status NOT IN ('completed', 'cancelled');

    INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
    VALUES (
      v_task.job_id,
      'generation.failed',
      'generation:image:failed:' || v_generation_id::TEXT,
      jsonb_build_object(
        'generation_id', v_generation_id,
        'provider_task_id', v_task.id,
        'error_code', v_error_code,
        'error_message', v_error_message
      )
    )
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

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
    'provider.submit_failed',
    'provider:submit_failed:' || v_task.id::TEXT,
    jsonb_build_object(
      'provider_task_id', v_task.id,
      'provider', v_task.provider,
      'model', v_task.model,
      'error', COALESCE(p_error, '{}'::JSONB)
    ),
    v_task.creative_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'provider_task_id', v_task.id,
    'status', v_task.status,
    'generation_id', v_generation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_provider_submit_failure(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_provider_submit_failure(UUID, JSONB)
  TO service_role;

-- Convenience wrapper used by callers that want an explicit job/task correlation gate.
CREATE OR REPLACE FUNCTION public.orchestrator_fail_image_provider_submit(
  p_job_id UUID,
  p_provider_task_id UUID,
  p_error_code TEXT,
  p_error_message TEXT,
  p_error JSONB DEFAULT '{}'::JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_error JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.provider_tasks pt
    WHERE pt.id = p_provider_task_id
      AND pt.job_id = p_job_id
  ) THEN
    RAISE EXCEPTION 'provider task does not belong to image generation job';
  END IF;

  v_error := COALESCE(p_error, '{}'::JSONB)
    || jsonb_build_object(
      'code', COALESCE(NULLIF(p_error_code, ''), p_error->>'code', 'KIE_SUBMIT_REJECTED'),
      'message', COALESCE(NULLIF(p_error_message, ''), p_error->>'message', 'KIE createTask was rejected')
    );

  PERFORM public.orchestrator_record_provider_submit_failure(p_provider_task_id, v_error);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_fail_image_provider_submit(UUID, UUID, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_fail_image_provider_submit(UUID, UUID, TEXT, TEXT, JSONB)
  TO service_role;
