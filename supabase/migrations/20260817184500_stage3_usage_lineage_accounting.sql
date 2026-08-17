-- Stage 3 / S3-005 DoD closing: durable pricing evidence, cost/usage accounting,
-- and late-bound creative_run lineage.
--
-- Provider list-price snapshots are persisted with the provider task before the
-- irreversible submit permit is claimed. They are estimates, never silently promoted
-- to actual billing. recordInfo credits are copied into one deduped cost event per task.

ALTER TABLE public.provider_tasks
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(12, 6),
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE public.provider_tasks
  DROP CONSTRAINT IF EXISTS provider_tasks_estimated_cost_nonnegative;
ALTER TABLE public.provider_tasks
  ADD CONSTRAINT provider_tasks_estimated_cost_nonnegative
    CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0);

-- ---------------------------------------------------------------------------
-- Immutable-at-first-write KIE image pricing snapshot.
-- The snapshot is intentionally dated. A future pricing update should be a new
-- migration/version rather than rewriting historical evidence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_apply_provider_pricing_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_resolution TEXT;
  v_estimate NUMERIC(12, 6);
  v_family TEXT;
BEGIN
  IF NEW.provider <> 'kie' OR NEW.estimated_cost_usd IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_resolution := upper(COALESCE(
    NULLIF(NEW.request_payload #>> '{input,resolution}', ''),
    '2K'
  ));

  IF NEW.model IN (
    'gpt-image-2',
    'gpt-image-2-text-to-image',
    'gpt-image-2-image-to-image'
  ) THEN
    v_family := 'gpt-image-2';
    v_estimate := CASE v_resolution
      WHEN '1K' THEN 0.030000
      WHEN '2K' THEN 0.050000
      WHEN '4K' THEN 0.080000
      ELSE NULL
    END;
  ELSIF NEW.model IN ('nano-banana-2', 'nano-banana-2-lite') THEN
    v_family := 'nano-banana-2';
    v_estimate := CASE v_resolution
      WHEN '1K' THEN 0.040000
      WHEN '2K' THEN 0.060000
      WHEN '4K' THEN 0.090000
      ELSE NULL
    END;
  END IF;

  IF v_estimate IS NOT NULL THEN
    NEW.estimated_cost_usd := v_estimate;
    NEW.pricing_snapshot := jsonb_build_object(
      'provider', 'kie',
      'model_family', v_family,
      'resolution', v_resolution,
      'currency', 'USD',
      'unit', 'image',
      'price_usd_per_image', v_estimate,
      'failed_task_cost_usd', 0,
      'basis', 'public_list_price_estimate',
      'snapshot_date', '2026-08-17',
      'source_url', 'https://kie.ai/pricing'
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_apply_provider_pricing_snapshot()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS provider_tasks_apply_pricing_snapshot ON public.provider_tasks;
CREATE TRIGGER provider_tasks_apply_pricing_snapshot
  BEFORE INSERT OR UPDATE OF provider, model, request_payload
  ON public.provider_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.orchestrator_apply_provider_pricing_snapshot();

-- ---------------------------------------------------------------------------
-- Aggregate helper. `estimated_cost_usd` is the best currently known effective cost;
-- `actual_cost_usd` only sums events backed by an actual provider cost.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_refresh_creative_run_accounting(
  p_creative_run_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_effective_cost NUMERIC(12, 6) := 0;
  v_actual_cost NUMERIC(12, 6) := 0;
  v_credits NUMERIC(18, 6) := 0;
  v_provider_task_count INTEGER := 0;
BEGIN
  IF p_creative_run_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(cost_usd), 0),
    COALESCE(SUM(CASE WHEN estimated = false THEN cost_usd ELSE 0 END), 0),
    COALESCE(SUM(credits), 0),
    COUNT(DISTINCT provider_task_id)::INTEGER
  INTO
    v_effective_cost,
    v_actual_cost,
    v_credits,
    v_provider_task_count
  FROM public.factory_cost_events
  WHERE creative_run_id = p_creative_run_id;

  UPDATE public.creative_runs
  SET
    estimated_cost_usd = v_effective_cost,
    actual_cost_usd = v_actual_cost,
    usage = COALESCE(usage, '{}'::JSONB) || jsonb_build_object(
      'provider_accounting',
      jsonb_build_object(
        'credits', v_credits,
        'provider_task_count', v_provider_task_count,
        'effective_cost_usd', v_effective_cost,
        'actual_cost_usd', v_actual_cost,
        'contains_estimates', EXISTS (
          SELECT 1
          FROM public.factory_cost_events
          WHERE creative_run_id = p_creative_run_id
            AND estimated = true
        )
      )
    )
  WHERE id = p_creative_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_refresh_creative_run_accounting(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_refresh_creative_run_accounting(UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- One idempotent accounting event per provider task. The row begins as an estimate
-- before the paid side effect and is enriched with recordInfo credits / actual cost later.
-- ---------------------------------------------------------------------------
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
BEGIN
  IF jsonb_typeof(NEW.pricing_snapshot -> 'failed_task_cost_usd') = 'number' THEN
    v_failed_task_cost := (NEW.pricing_snapshot ->> 'failed_task_cost_usd')::NUMERIC;
  END IF;

  IF NEW.cost_usd IS NOT NULL THEN
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
      WHEN NEW.estimated_cost_usd IS NULL THEN 'unknown_zero_placeholder'
      ELSE 'public_list_price_estimate'
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
    credits_used,
    cost_usd,
    estimated_cost_usd,
    pricing_snapshot,
    creative_run_id
  ON public.provider_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.orchestrator_sync_provider_accounting();

-- ---------------------------------------------------------------------------
-- Late-bind Stage 2 creative_runs to already-running/completed durable execution.
-- Agent creative lineage is intentionally written after the turn, so Stage 3 lineage
-- must support this temporal order without losing provider/cost evidence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_attach_creative_run_to_generation(
  p_creative_run_id UUID,
  p_generation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.creative_runs%ROWTYPE;
  v_generation public.generations%ROWTYPE;
  v_job_id UUID;
  v_stage_count INTEGER := 0;
  v_task_count INTEGER := 0;
  v_event_count INTEGER := 0;
  v_cost_count INTEGER := 0;
BEGIN
  IF p_creative_run_id IS NULL OR p_generation_id IS NULL THEN
    RAISE EXCEPTION 'creative_run_id and generation_id are required';
  END IF;

  SELECT *
  INTO v_run
  FROM public.creative_runs
  WHERE id = p_creative_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'creative run not found';
  END IF;

  SELECT *
  INTO v_generation
  FROM public.generations
  WHERE id = p_generation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'generation not found';
  END IF;

  IF v_run.user_id IS DISTINCT FROM v_generation.user_id
     OR v_run.project_id IS DISTINCT FROM v_generation.project_id THEN
    RAISE EXCEPTION 'creative run and generation ownership mismatch';
  END IF;

  IF v_run.generation_id IS NOT NULL
     AND v_run.generation_id IS DISTINCT FROM p_generation_id THEN
    RAISE EXCEPTION 'creative run is already linked to another generation';
  END IF;

  v_job_id := v_generation.factory_job_id;
  IF v_job_id IS NULL THEN
    RETURN jsonb_build_object(
      'attached', false,
      'reason', 'generation_has_no_factory_job',
      'creative_run_id', p_creative_run_id,
      'generation_id', p_generation_id
    );
  END IF;

  IF v_run.factory_job_id IS NOT NULL
     AND v_run.factory_job_id IS DISTINCT FROM v_job_id THEN
    RAISE EXCEPTION 'creative run is already linked to another factory job';
  END IF;

  -- Avoid recursive UPDATE OF generation_id from the auto-attach trigger. Manual repair
  -- may fill a missing generation_id once; the nested trigger then takes the branch below.
  IF v_run.generation_id IS NULL THEN
    UPDATE public.creative_runs
    SET
      generation_id = p_generation_id,
      factory_job_id = COALESCE(factory_job_id, v_job_id)
    WHERE id = p_creative_run_id;
  ELSE
    UPDATE public.creative_runs
    SET factory_job_id = COALESCE(factory_job_id, v_job_id)
    WHERE id = p_creative_run_id;
  END IF;

  UPDATE public.factory_job_stages
  SET creative_run_id = p_creative_run_id
  WHERE job_id = v_job_id
    AND creative_run_id IS NULL;
  GET DIAGNOSTICS v_stage_count = ROW_COUNT;

  UPDATE public.provider_tasks
  SET creative_run_id = p_creative_run_id
  WHERE job_id = v_job_id
    AND creative_run_id IS NULL;
  GET DIAGNOSTICS v_task_count = ROW_COUNT;

  UPDATE public.factory_workflow_events
  SET creative_run_id = p_creative_run_id
  WHERE job_id = v_job_id
    AND creative_run_id IS NULL;
  GET DIAGNOSTICS v_event_count = ROW_COUNT;

  UPDATE public.factory_cost_events
  SET creative_run_id = p_creative_run_id
  WHERE job_id = v_job_id
    AND creative_run_id IS NULL;
  GET DIAGNOSTICS v_cost_count = ROW_COUNT;

  PERFORM public.orchestrator_refresh_creative_run_accounting(p_creative_run_id);

  INSERT INTO public.factory_workflow_events (
    job_id,
    event_type,
    dedupe_key,
    payload,
    creative_run_id
  )
  VALUES (
    v_job_id,
    'creative.lineage_attached',
    'creative:lineage:' || p_creative_run_id::TEXT,
    jsonb_build_object(
      'creative_run_id', p_creative_run_id,
      'generation_id', p_generation_id,
      'stage_count', v_stage_count,
      'provider_task_count', v_task_count,
      'event_count', v_event_count,
      'cost_event_count', v_cost_count
    ),
    p_creative_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'attached', true,
    'creative_run_id', p_creative_run_id,
    'generation_id', p_generation_id,
    'factory_job_id', v_job_id,
    'stage_count', v_stage_count,
    'provider_task_count', v_task_count,
    'event_count', v_event_count,
    'cost_event_count', v_cost_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_attach_creative_run_to_generation(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_attach_creative_run_to_generation(UUID, UUID)
  TO service_role;

-- Automatic late-binding for Stage 2's post-turn creative lineage writer.
CREATE OR REPLACE FUNCTION public.orchestrator_auto_attach_creative_run()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.generation_id IS NOT NULL THEN
    PERFORM public.orchestrator_attach_creative_run_to_generation(NEW.id, NEW.generation_id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_auto_attach_creative_run()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS creative_runs_auto_attach_durable_lineage ON public.creative_runs;
CREATE TRIGGER creative_runs_auto_attach_durable_lineage
  AFTER INSERT OR UPDATE OF generation_id
  ON public.creative_runs
  FOR EACH ROW
  WHEN (NEW.generation_id IS NOT NULL)
  EXECUTE FUNCTION public.orchestrator_auto_attach_creative_run();
