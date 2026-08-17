-- Stage 3: Durable Core Orchestrator — worker runtime primitives

CREATE OR REPLACE FUNCTION public.orchestrator_worker_heartbeat(
  p_worker_id TEXT,
  p_build_sha TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started_at TIMESTAMPTZ;
  v_heartbeat_at TIMESTAMPTZ;
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
    build_sha = COALESCE(EXCLUDED.build_sha, public.orchestrator_workers.build_sha),
    metadata = EXCLUDED.metadata
  RETURNING started_at, last_heartbeat_at
  INTO v_started_at, v_heartbeat_at;

  RETURN jsonb_build_object(
    'worker_id', p_worker_id,
    'started_at', v_started_at,
    'last_heartbeat_at', v_heartbeat_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_worker_heartbeat(TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_worker_heartbeat(TEXT, TEXT, JSONB)
  TO service_role;
