-- Stage 3 / S3-005 pricing-evidence correction.
-- KIE's GPT Image 2 createTask examples allow requests without an explicit resolution,
-- while the public price table is resolution-specific. Do not guess a billable tier when
-- the durable request did not specify one; persist the ambiguity as evidence instead.

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

  IF NOT EXISTS (
    SELECT 1
    FROM public.factory_jobs fj
    WHERE fj.id = NEW.job_id
      AND fj.workflow_kind = 'generation_image'
  ) THEN
    RETURN NEW;
  END IF;

  v_resolution := upper(NULLIF(NEW.request_payload #>> '{input,resolution}', ''));

  IF NEW.model IN (
    'gpt-image-2',
    'gpt-image-2-text-to-image',
    'gpt-image-2-image-to-image'
  ) THEN
    v_family := 'gpt-image-2';
  ELSIF NEW.model IN ('nano-banana-2', 'nano-banana-2-lite') THEN
    v_family := 'nano-banana-2';
  ELSE
    RETURN NEW;
  END IF;

  IF v_resolution IS NULL THEN
    NEW.pricing_snapshot := jsonb_build_object(
      'provider', 'kie',
      'model_family', v_family,
      'currency', 'USD',
      'unit', 'image',
      'failed_task_cost_usd', 0,
      'basis', 'resolution_unspecified_no_price_estimate',
      'snapshot_date', '2026-08-17',
      'source_url', 'https://kie.ai/pricing'
    );
    RETURN NEW;
  END IF;

  IF v_family = 'gpt-image-2' THEN
    v_estimate := CASE v_resolution
      WHEN '1K' THEN 0.030000
      WHEN '2K' THEN 0.050000
      WHEN '4K' THEN 0.080000
      ELSE NULL
    END;
  ELSE
    v_estimate := CASE v_resolution
      WHEN '1K' THEN 0.040000
      WHEN '2K' THEN 0.060000
      WHEN '4K' THEN 0.090000
      ELSE NULL
    END;
  END IF;

  IF v_estimate IS NULL THEN
    NEW.pricing_snapshot := jsonb_build_object(
      'provider', 'kie',
      'model_family', v_family,
      'resolution', v_resolution,
      'currency', 'USD',
      'unit', 'image',
      'failed_task_cost_usd', 0,
      'basis', 'unsupported_resolution_no_price_estimate',
      'snapshot_date', '2026-08-17',
      'source_url', 'https://kie.ai/pricing'
    );
    RETURN NEW;
  END IF;

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

  RETURN NEW;
END;
$$;

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
  IF NOT EXISTS (
    SELECT 1
    FROM public.factory_jobs fj
    WHERE fj.id = NEW.job_id
      AND fj.workflow_kind = 'generation_image'
  ) THEN
    RETURN NEW;
  END IF;

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

REVOKE ALL ON FUNCTION public.orchestrator_apply_provider_pricing_snapshot()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.orchestrator_sync_provider_accounting()
  FROM PUBLIC, anon, authenticated;
