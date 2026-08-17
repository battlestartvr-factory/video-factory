-- Stage 3: Durable Core Orchestrator — worker runtime primitives.
-- Worker heartbeat is observability only; factory_jobs leases remain the locking authority.

CREATE OR REPLACE FUNCTION public.orchestrator_worker_heartbeat(
  p_worker_id TEXT,
  p_build_sha TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'worker_id is required';
  END IF;

  INSERT INTO public.orchestrator_workers (
    worker_id,
    started_at,
    last_heartbeat_at,
    build_sha,
    metadata
  )
  VALUES (
    p_worker_id,
    NOW(),
    NOW(),
    p_build_sha,
    COALESCE(p_metadata, '{}'::JSONB)
  )
  ON CONFLICT (worker_id) DO UPDATE
  SET
    last_heartbeat_at = NOW(),
    build_sha = EXCLUDED.build_sha,
    metadata = EXCLUDED.metadata;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_worker_heartbeat(TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_worker_heartbeat(TEXT, TEXT, JSONB)
  TO service_role;
