-- Nano Banana Pro is enabled for durable execution, but we do not yet have a dated
-- verified list-price snapshot in this repository. Preserve explicit evidence rather than
-- guessing a price. Provider credits can still be recorded by canonical reconciliation.

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
  ELSIF NEW.model = 'nano-banana-pro' THEN
    v_family := 'nano-banana-pro';
  ELSE
    RETURN NEW;
  END IF;

  IF v_family = 'nano-banana-pro' THEN
    NEW.pricing_snapshot := jsonb_strip_nulls(jsonb_build_object(
      'provider', 'kie',
      'model_family', v_family,
      'resolution', v_resolution,
      'currency', 'USD',
      'unit', 'image',
      'failed_task_cost_usd', 0,
      'basis', 'pricing_not_configured_no_price_estimate',
      'snapshot_date', '2026-08-18'
    ));
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

REVOKE ALL ON FUNCTION public.orchestrator_apply_provider_pricing_snapshot()
  FROM PUBLIC, anon, authenticated;
