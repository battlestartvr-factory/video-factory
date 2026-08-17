-- Stage 3 / S3-005 accounting gate.
-- Persist pricing evidence at provider-task preparation time, but do not count an
-- estimated provider cost until the irreversible paid-submit permit has actually been
-- consumed. This keeps "prepared but never submitted" jobs at zero effective cost.

CREATE OR REPLACE FUNCTION public.orchestrator_sync_provider_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_failed_task_cost NUMERIC(12, 6);
  v_effective_cost NUMERIC(12, 6);
  v_is_estimated BOOLEAN;
  v_cost_basis TEXT;
  v_job_effective_cost NUMERIC(12, 6);
  v_job_actual_cost NUMERIC(12, 6);
  v_submit_started BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.factory_jobs fj
    WHERE fj.id = NEW.job_id
      AND fj.workflow_kind = 'generation_image'
  ) THEN
    RETURN NEW;
  END IF;

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
    'image',
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

-- The submit-permit transition already changes `status`, but include attempts explicitly
-- so future refactors cannot make the accounting wake-up depend on that incidental detail.
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
