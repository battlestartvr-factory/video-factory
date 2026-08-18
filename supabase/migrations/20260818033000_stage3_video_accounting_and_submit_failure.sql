-- Stage 3 video hardening.
-- Extend the existing image submit-failure and paid-submit accounting invariants to
-- generation_video@1 without weakening the generation_image@1 path.

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
  v_generation_type TEXT;
  v_action_type TEXT;
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
  v_error_message := COALESCE(NULLIF(p_error->>'message', ''), 'KIE provider submission was rejected');

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

  SELECT g.id, g.type
  INTO v_generation_id, v_generation_type
  FROM public.generations AS g
  WHERE g.factory_job_id = v_task.job_id
    AND g.type IN ('image', 'video')
  ORDER BY g.created_at ASC
  LIMIT 1;

  IF v_generation_id IS NOT NULL THEN
    v_action_type := CASE
      WHEN v_generation_type = 'video' THEN 'generate_video'
      ELSE 'generate_image'
    END;

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
      AND action_type = v_action_type
      AND status NOT IN ('completed', 'cancelled');

    INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
    VALUES (
      v_task.job_id,
      'generation.failed',
      'generation:' || v_generation_type || ':failed:' || v_generation_id::TEXT,
      jsonb_build_object(
        'generation_id', v_generation_id,
        'generation_type', v_generation_type,
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
    'generation_id', v_generation_id,
    'generation_type', v_generation_type
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_provider_submit_failure(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_provider_submit_failure(UUID, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_sync_provider_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workflow_kind TEXT;
  v_capability TEXT;
  v_failed_task_cost NUMERIC(12, 6);
  v_effective_cost NUMERIC(12, 6);
  v_is_estimated BOOLEAN;
  v_cost_basis TEXT;
  v_job_effective_cost NUMERIC(12, 6);
  v_job_actual_cost NUMERIC(12, 6);
  v_submit_started BOOLEAN;
BEGIN
  SELECT fj.workflow_kind
  INTO v_workflow_kind
  FROM public.factory_jobs fj
  WHERE fj.id = NEW.job_id;

  IF v_workflow_kind NOT IN ('generation_image', 'generation_video') THEN
    RETURN NEW;
  END IF;

  v_capability := CASE
    WHEN v_workflow_kind = 'generation_video' THEN 'video'
    ELSE 'image'
  END;

  v_submit_started := NEW.submission_attempts > 0
    OR NEW.external_task_id IS NOT NULL
    OR NEW.status IN ('submitting', 'submitted', 'processing', 'reconciling', 'succeeded', 'failed');

  IF jsonb_typeof(NEW.pricing_snapshot -> 'failed_task_cost_usd') = 'number' THEN
    v_failed_task_cost := (NEW.pricing_snapshot ->> 'failed_task_cost_usd')::NUMERIC;
  END IF;

  IF NOT v_submit_started THEN
    v_effective_cost := 0;
    v_is_estimated := true;
    v_cost_basis := 'prepared_not_submitted_zero';
  ELSIF NEW.cost_usd IS NOT NULL THEN
    v_effective_cost := NEW.cost_usd;
    v_is_estimated := false;
    v_cost_basis := 'provider_actual';
  ELSIF NEW.status = 'failed' AND v_failed_task_cost IS NOT NULL THEN
    v_effective_cost := v_failed_task_cost;
    v_is_estimated := true;
    v_cost_basis := 'provider_failure_policy_estimate';
  ELSE
    v_effective_cost := COALESCE(NEW.estimated_cost_usd, 0);
    v_is_estimated := true;
    v_cost_basis := CASE
      WHEN NEW.estimated_cost_usd IS NOT NULL THEN 'public_list_price_estimate'
      ELSE COALESCE(
        NULLIF(NEW.pricing_snapshot ->> 'basis', ''),
        'unknown_zero_placeholder'
      )
    END;
  END IF;

  INSERT INTO public.factory_cost_events (
    job_id,
    stage_id,
    provider_task_id,
    provider,
    model,
    capability,
    units,
    credits,
    cost_usd,
    estimated,
    creative_run_id,
    dedupe_key
  )
  VALUES (
    NEW.job_id,
    NEW.stage_id,
    NEW.id,
    NEW.provider,
    NEW.model,
    v_capability,
    jsonb_strip_nulls(jsonb_build_object(
      'variant_index', NEW.variant_index,
      'provider_status', NEW.status,
      'submission_attempts', NEW.submission_attempts,
      'cost_basis', v_cost_basis,
      'pricing_snapshot', NULLIF(NEW.pricing_snapshot, '{}'::JSONB)
    )),
    NEW.credits_used,
    v_effective_cost,
    v_is_estimated,
    NEW.creative_run_id,
    'provider:cost:' || NEW.id::TEXT
  )
  ON CONFLICT (dedupe_key) DO UPDATE
  SET
    stage_id = EXCLUDED.stage_id,
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    capability = EXCLUDED.capability,
    units = EXCLUDED.units,
    credits = EXCLUDED.credits,
    cost_usd = EXCLUDED.cost_usd,
    estimated = EXCLUDED.estimated,
    creative_run_id = COALESCE(EXCLUDED.creative_run_id, public.factory_cost_events.creative_run_id);

  SELECT
    COALESCE(SUM(cost_usd), 0),
    COALESCE(SUM(CASE WHEN estimated = false THEN cost_usd ELSE 0 END), 0)
  INTO v_job_effective_cost, v_job_actual_cost
  FROM public.factory_cost_events
  WHERE job_id = NEW.job_id;

  UPDATE public.factory_jobs
  SET
    estimated_cost_usd = v_job_effective_cost,
    actual_cost_usd = v_job_actual_cost
  WHERE id = NEW.job_id;

  IF NEW.creative_run_id IS NOT NULL THEN
    PERFORM public.orchestrator_refresh_creative_run_accounting(NEW.creative_run_id);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_sync_provider_accounting()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS provider_tasks_sync_accounting ON public.provider_tasks;
CREATE TRIGGER provider_tasks_sync_accounting
  AFTER INSERT OR UPDATE OF
    status,
    submission_attempts,
    external_task_id,
    credits_used,
    cost_usd,
    estimated_cost_usd,
    pricing_snapshot,
    creative_run_id
  ON public.provider_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.orchestrator_sync_provider_accounting();
