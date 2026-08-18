-- Stage 4 / S4-002: durable game-discovery admission + parent/child job lineage.
-- Additive and service-role only. No paid provider side effect happens in this RPC.

ALTER TABLE public.factory_jobs
  ADD COLUMN IF NOT EXISTS parent_job_id UUID;

ALTER TABLE public.factory_jobs
  DROP CONSTRAINT IF EXISTS factory_jobs_parent_job_id_fkey;
ALTER TABLE public.factory_jobs
  ADD CONSTRAINT factory_jobs_parent_job_id_fkey
    FOREIGN KEY (parent_job_id) REFERENCES public.factory_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_factory_jobs_parent_created
  ON public.factory_jobs (parent_job_id, created_at)
  WHERE parent_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.orchestrator_create_game_discovery_batch(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_request_id UUID := NULLIF(payload->>'request_id', '')::UUID;
  v_user_id UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_project_id UUID := NULLIF(payload->>'project_id', '')::UUID;
  v_objective JSONB := COALESCE(payload->'discovery_objective', '{}'::JSONB);
  v_title TEXT := NULLIF(trim(payload#>>'{discovery_objective,title}'), '');
  v_search_intent TEXT := NULLIF(trim(payload#>>'{discovery_objective,searchIntent}'), '');
  v_hypothesis TEXT := NULLIF(trim(payload->>'hypothesis'), '');
  v_creative_run public.creative_runs%ROWTYPE;
  v_job public.factory_jobs%ROWTYPE;
  v_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
BEGIN
  IF v_request_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_id and user_id are required';
  END IF;
  IF jsonb_typeof(v_objective) <> 'object' OR v_objective = '{}'::JSONB THEN
    RAISE EXCEPTION 'discovery_objective object is required';
  END IF;
  IF v_objective->>'schema' IS DISTINCT FROM 'discovery_objective'
     OR v_objective->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'unsupported discovery_objective schema/version';
  END IF;
  IF v_title IS NULL OR v_search_intent IS NULL THEN
    RAISE EXCEPTION 'discovery objective title and searchIntent are required';
  END IF;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE request_id = v_request_id;

  IF FOUND THEN
    IF v_job.user_id IS DISTINCT FROM v_user_id
       OR v_job.workflow_kind IS DISTINCT FROM 'game_discovery_batch'
       OR v_job.workflow_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'request_id collision with another workflow';
    END IF;

    SELECT * INTO v_creative_run
    FROM public.creative_runs
    WHERE factory_job_id = v_job.id
      AND metadata->>'domain_kind' = 'game_discovery_batch'
    ORDER BY created_at ASC
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'duplicate discovery batch is missing creative run';
    END IF;

    RETURN jsonb_build_object(
      'creative_run', to_jsonb(v_creative_run),
      'factory_job_id', v_job.id,
      'duplicate', true,
      'queue_msg_id', NULL
    );
  END IF;

  INSERT INTO public.creative_runs (
    user_id,
    project_id,
    run_type,
    status,
    title,
    objective,
    hypothesis,
    inputs,
    outputs,
    metadata
  )
  VALUES (
    v_user_id,
    v_project_id,
    'mixed',
    'queued',
    v_title,
    v_search_intent,
    COALESCE(v_hypothesis, v_search_intent),
    jsonb_build_object('discovery_objective', v_objective),
    '{}'::JSONB,
    jsonb_build_object(
      'domain_kind', 'game_discovery_batch',
      'domain_schema', 'discovery_objective',
      'domain_version', 1,
      'request_id', v_request_id
    )
  )
  RETURNING * INTO v_creative_run;

  INSERT INTO public.factory_jobs (
    request_id,
    project_id,
    user_id,
    workflow_kind,
    workflow_version,
    status,
    current_stage,
    progress,
    input,
    state,
    next_action_at
  )
  VALUES (
    v_request_id,
    v_project_id,
    v_user_id,
    'game_discovery_batch',
    1,
    'queued',
    'objective_ready',
    0,
    jsonb_build_object(
      'creative_run_id', v_creative_run.id,
      'discovery_objective', v_objective
    ),
    jsonb_build_object(
      'creative_run_id', v_creative_run.id,
      'discovery_objective', v_objective,
      'stage4_schema_version', 1
    ),
    NOW()
  )
  RETURNING * INTO v_job;

  UPDATE public.creative_runs
  SET factory_job_id = v_job.id
  WHERE id = v_creative_run.id
  RETURNING * INTO v_creative_run;

  SELECT msg_id INTO v_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object(
      'v', 1,
      'job_id', v_job.id,
      'reason', 'game_discovery_created',
      'trace_id', v_trace_id
    ),
    0
  ) AS msg_id;

  UPDATE public.factory_jobs
  SET last_enqueued_at = NOW()
  WHERE id = v_job.id;

  INSERT INTO public.factory_workflow_events (
    job_id,
    event_type,
    dedupe_key,
    payload,
    creative_run_id
  )
  VALUES (
    v_job.id,
    'job.enqueued',
    'queue:enqueued:' || v_msg_id::TEXT,
    jsonb_build_object(
      'queue', 'core_orchestrator_v1',
      'queue_msg_id', v_msg_id,
      'reason', 'game_discovery_created',
      'creative_run_id', v_creative_run.id,
      'trace_id', v_trace_id
    ),
    v_creative_run.id
  );

  RETURN jsonb_build_object(
    'creative_run', to_jsonb(v_creative_run),
    'factory_job_id', v_job.id,
    'duplicate', false,
    'queue_msg_id', v_msg_id,
    'trace_id', v_trace_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_create_game_discovery_batch(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_create_game_discovery_batch(JSONB)
  TO service_role;
