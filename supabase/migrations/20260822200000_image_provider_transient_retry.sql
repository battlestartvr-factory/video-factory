-- Bounded image-provider retry support.
--
-- Definitive retryable createTask failures (HTTP 408/429/5xx) must close the current
-- provider-task/stage attempt without terminally failing the linked generation. The worker
-- will create a fresh provider task with a fresh submission key after bounded backoff.
-- Ambiguous submit failures remain callback-only and never use this function.

CREATE OR REPLACE FUNCTION public.orchestrator_record_provider_retryable_submit_failure(
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
    RAISE EXCEPTION 'cannot mark submitted provider task as retryable submit failure';
  END IF;

  IF COALESCE((p_error->>'retryable')::BOOLEAN, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'retryable provider submit failure requires retryable=true';
  END IF;

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

  SELECT g.id
  INTO v_generation_id
  FROM public.generations AS g
  WHERE g.factory_job_id = v_task.job_id
    AND g.type = 'image';

  IF v_generation_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.generations g
    WHERE g.id = v_generation_id
      AND g.status IN ('failed', 'cancelled', 'completed')
  ) THEN
    RAISE EXCEPTION 'retryable submit failure cannot reopen a terminal generation';
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
    'provider.submit_retryable_failure',
    'provider:submit_retryable_failure:' || v_task.id::TEXT,
    jsonb_build_object(
      'provider_task_id', v_task.id,
      'provider', v_task.provider,
      'model', v_task.model,
      'generation_id', v_generation_id,
      'error', COALESCE(p_error, '{}'::JSONB)
    ),
    v_task.creative_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'provider_task_id', v_task.id,
    'status', v_task.status,
    'generation_id', v_generation_id,
    'generation_terminal', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_provider_retryable_submit_failure(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_provider_retryable_submit_failure(UUID, JSONB)
  TO service_role;

UPDATE public.deployment_schema_contract
SET schema_version = '20260822200000',
    updated_at = NOW()
WHERE singleton = TRUE;
