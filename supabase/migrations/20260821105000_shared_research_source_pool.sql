-- Shared verified source acquisition for Stage 4.5.
-- Exactly one Scout request owns web acquisition for a research run; the other
-- four wait for and reuse the durable pool. This prevents a five-way KIE search
-- stampede while preserving the existing five-Scout fan-out and Human Gates.

CREATE TABLE IF NOT EXISTS public.research_shared_source_pools (
  research_run_id UUID PRIMARY KEY REFERENCES public.research_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acquiring','ready','failed')),
  owner_job_id UUID REFERENCES public.factory_jobs(id) ON DELETE SET NULL,
  lease_expires_at TIMESTAMPTZ,
  pool JSONB,
  usage JSONB NOT NULL DEFAULT '{}'::JSONB,
  error JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS research_shared_source_pools_status_idx
  ON public.research_shared_source_pools(status, lease_expires_at);

ALTER TABLE public.research_shared_source_pools ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_shared_source_pools FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.research_shared_source_pools TO service_role;

CREATE OR REPLACE FUNCTION public.research_acquire_shared_source_pool(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_row public.research_shared_source_pools%ROWTYPE;
BEGIN
  IF v_run_id IS NULL OR v_job_id IS NULL THEN
    RAISE EXCEPTION 'research_run_id and job_id are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.research_runs WHERE id = v_run_id) THEN
    RAISE EXCEPTION 'research run not found: %', v_run_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.research_scout_assignments
    WHERE run_id = v_run_id AND factory_job_id = v_job_id
  ) THEN
    RAISE EXCEPTION 'job % is not a Scout assignment for research run %', v_job_id, v_run_id;
  END IF;

  INSERT INTO public.research_shared_source_pools(research_run_id)
  VALUES (v_run_id)
  ON CONFLICT (research_run_id) DO NOTHING;

  SELECT * INTO v_row
  FROM public.research_shared_source_pools
  WHERE research_run_id = v_run_id
  FOR UPDATE;

  IF v_row.status = 'ready' THEN
    RETURN jsonb_build_object(
      'status', 'ready',
      'acquired', false,
      'owner_job_id', v_row.owner_job_id,
      'pool', v_row.pool,
      'usage', v_row.usage,
      'error', NULL
    );
  END IF;

  IF v_row.status = 'failed' THEN
    RETURN jsonb_build_object(
      'status', 'failed',
      'acquired', false,
      'owner_job_id', v_row.owner_job_id,
      'pool', NULL,
      'usage', v_row.usage,
      'error', COALESCE(v_row.error, '{}'::JSONB)
    );
  END IF;

  IF v_row.status = 'acquiring'
     AND v_row.owner_job_id IS DISTINCT FROM v_job_id
     AND v_row.lease_expires_at IS NOT NULL
     AND v_row.lease_expires_at > NOW() THEN
    RETURN jsonb_build_object(
      'status', 'acquiring',
      'acquired', false,
      'owner_job_id', v_row.owner_job_id,
      'lease_expires_at', v_row.lease_expires_at,
      'pool', NULL,
      'error', NULL
    );
  END IF;

  UPDATE public.research_shared_source_pools
  SET
    status = 'acquiring',
    owner_job_id = v_job_id,
    lease_expires_at = NOW() + INTERVAL '115 seconds',
    attempt_count = attempt_count + 1,
    pool = NULL,
    usage = '{}'::JSONB,
    error = NULL,
    updated_at = NOW()
  WHERE research_run_id = v_run_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'status', 'acquiring',
    'acquired', true,
    'owner_job_id', v_job_id,
    'lease_expires_at', v_row.lease_expires_at,
    'attempt_count', v_row.attempt_count,
    'pool', NULL,
    'error', NULL
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.research_complete_shared_source_pool(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_pool JSONB := payload->'pool';
  v_usage JSONB := COALESCE(payload->'usage', '{}'::JSONB);
  v_row public.research_shared_source_pools%ROWTYPE;
BEGIN
  IF v_run_id IS NULL OR v_job_id IS NULL OR jsonb_typeof(v_pool) <> 'object' THEN
    RAISE EXCEPTION 'research_run_id, job_id and pool are required';
  END IF;
  IF v_pool->>'schema' <> 'shared_research_source_pool'
     OR COALESCE((v_pool->>'version')::INTEGER, 0) <> 1
     OR v_pool->>'researchRunId' <> v_run_id::TEXT
     OR jsonb_typeof(v_pool->'sources') <> 'array'
     OR jsonb_array_length(v_pool->'sources') < 1 THEN
    RAISE EXCEPTION 'invalid shared research source pool payload';
  END IF;

  SELECT * INTO v_row
  FROM public.research_shared_source_pools
  WHERE research_run_id = v_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shared source pool row not found';
  END IF;
  IF v_row.status = 'ready' THEN
    RETURN jsonb_build_object('status', 'ready', 'duplicate', true, 'pool', v_row.pool, 'usage', v_row.usage);
  END IF;
  IF v_row.status <> 'acquiring' OR v_row.owner_job_id IS DISTINCT FROM v_job_id THEN
    RAISE EXCEPTION 'shared source pool completion owner mismatch';
  END IF;

  UPDATE public.research_shared_source_pools
  SET
    status = 'ready',
    pool = v_pool,
    usage = v_usage,
    error = NULL,
    lease_expires_at = NULL,
    updated_at = NOW()
  WHERE research_run_id = v_run_id;

  RETURN jsonb_build_object('status', 'ready', 'duplicate', false, 'pool', v_pool, 'usage', v_usage);
END;
$function$;

CREATE OR REPLACE FUNCTION public.research_fail_shared_source_pool(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_error JSONB := COALESCE(payload->'error', '{}'::JSONB);
  v_usage JSONB := COALESCE(payload->'usage', '{}'::JSONB);
  v_row public.research_shared_source_pools%ROWTYPE;
BEGIN
  IF v_run_id IS NULL OR v_job_id IS NULL THEN
    RAISE EXCEPTION 'research_run_id and job_id are required';
  END IF;
  SELECT * INTO v_row
  FROM public.research_shared_source_pools
  WHERE research_run_id = v_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shared source pool row not found';
  END IF;
  IF v_row.status = 'ready' THEN
    RETURN jsonb_build_object('status', 'ready', 'ignored', true);
  END IF;
  IF v_row.owner_job_id IS DISTINCT FROM v_job_id THEN
    RETURN jsonb_build_object('status', v_row.status, 'ignored', true);
  END IF;

  UPDATE public.research_shared_source_pools
  SET
    status = 'failed',
    error = v_error,
    usage = v_usage,
    lease_expires_at = NULL,
    updated_at = NOW()
  WHERE research_run_id = v_run_id;

  RETURN jsonb_build_object('status', 'failed', 'ignored', false, 'error', v_error, 'usage', v_usage);
END;
$function$;

CREATE OR REPLACE FUNCTION public.research_get_shared_source_pool(p_research_run_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN rsp.research_run_id IS NULL THEN jsonb_build_object('status', 'missing')
    ELSE jsonb_build_object(
      'status', rsp.status,
      'owner_job_id', rsp.owner_job_id,
      'lease_expires_at', rsp.lease_expires_at,
      'pool', rsp.pool,
      'usage', rsp.usage,
      'error', rsp.error,
      'attempt_count', rsp.attempt_count,
      'updated_at', rsp.updated_at
    )
  END
  FROM (SELECT 1) AS singleton
  LEFT JOIN public.research_shared_source_pools rsp
    ON rsp.research_run_id = p_research_run_id;
$function$;

REVOKE ALL ON FUNCTION public.research_acquire_shared_source_pool(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_complete_shared_source_pool(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_fail_shared_source_pool(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_get_shared_source_pool(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_acquire_shared_source_pool(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.research_complete_shared_source_pool(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.research_fail_shared_source_pool(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.research_get_shared_source_pool(UUID) TO service_role;
