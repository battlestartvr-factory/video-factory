-- Fix the durable research trace event namespace guard.
-- The previous regex was over-escaped in PostgreSQL and rejected valid events such as
-- research.source_pool.source_rejected. Use a bracketed literal dot to avoid escaping ambiguity.

CREATE OR REPLACE FUNCTION public.research_record_progress_event(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_job_id UUID;
  v_job_id UUID;
  v_research_run_id UUID;
  v_scout_role TEXT := NULLIF(payload->>'scout_role', '');
  v_event_type TEXT := NULLIF(trim(payload->>'event_type'), '');
  v_dedupe_key TEXT := NULLIF(trim(payload->>'dedupe_key'), '');
  v_payload JSONB := COALESCE(payload->'payload', '{}'::JSONB);
  v_row public.research_progress_events%ROWTYPE;
BEGIN
  SELECT fj.id
  INTO v_root_job_id
  FROM public.factory_jobs AS fj
  WHERE fj.id::TEXT = payload->>'root_factory_job_id'
    AND fj.workflow_kind = 'game_discovery_batch'
    AND fj.workflow_version IN (2, 3);

  IF v_root_job_id IS NULL THEN
    RAISE EXCEPTION 'invalid Game Discovery v2/v3 root job';
  END IF;
  IF v_event_type IS NULL OR v_event_type !~ '^(research|concept|job)[.]' THEN
    RAISE EXCEPTION 'invalid research progress event type';
  END IF;
  IF v_dedupe_key IS NULL OR length(v_dedupe_key) > 500 THEN
    RAISE EXCEPTION 'invalid research progress dedupe key';
  END IF;

  SELECT fj.id INTO v_job_id
  FROM public.factory_jobs AS fj
  WHERE fj.id::TEXT = NULLIF(payload->>'job_id', '');

  SELECT rr.id INTO v_research_run_id
  FROM public.research_runs AS rr
  WHERE rr.id::TEXT = NULLIF(payload->>'research_run_id', '');

  INSERT INTO public.research_progress_events(
    root_factory_job_id,
    job_id,
    research_run_id,
    scout_role,
    event_type,
    dedupe_key,
    payload
  )
  VALUES (
    v_root_job_id,
    v_job_id,
    v_research_run_id,
    v_scout_role,
    v_event_type,
    v_dedupe_key,
    v_payload
  )
  ON CONFLICT (dedupe_key) DO UPDATE
    SET dedupe_key = EXCLUDED.dedupe_key
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'sequence_id', v_row.sequence_id,
    'event_type', v_row.event_type,
    'created_at', v_row.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.research_record_progress_event(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_record_progress_event(JSONB) TO service_role;

UPDATE public.deployment_schema_contract
SET schema_version = '20260822090000', updated_at = NOW()
WHERE singleton = TRUE;
