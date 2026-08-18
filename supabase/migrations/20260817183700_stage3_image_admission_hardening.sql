-- Stage 3 / S3-005 hardening: keep preset_id strongly typed as UUID in the atomic
-- admission RPC. This replacement is intentionally append-only for safe deployments.

CREATE OR REPLACE FUNCTION public.orchestrator_create_image_generation(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_request_id UUID := NULLIF(payload->>'request_id', '')::UUID;
  v_user_id UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_project_id UUID := NULLIF(payload->>'project_id', '')::UUID;
  v_chat_id UUID := NULLIF(payload->>'chat_id', '')::UUID;
  v_message_id UUID := NULLIF(payload->>'message_id', '')::UUID;
  v_agent_run_id UUID := NULLIF(payload->>'agent_run_id', '')::UUID;
  v_prompt TEXT := NULLIF(trim(payload->>'prompt'), '');
  v_model_id TEXT := NULLIF(trim(payload->>'model_id'), '');
  v_preset_id UUID := NULLIF(payload->>'preset_id', '')::UUID;
  v_mode TEXT := COALESCE(NULLIF(trim(payload->>'mode'), ''), 'text-to-image');
  v_settings JSONB := COALESCE(payload->'settings', '{}'::JSONB);
  v_reference_assets JSONB := COALESCE(payload->'reference_assets', '[]'::JSONB);
  v_action_input JSONB := COALESCE(payload->'action_input', '{}'::JSONB);
  v_generation public.generations%ROWTYPE;
  v_action public.agent_actions%ROWTYPE;
  v_job_id UUID;
  v_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
BEGIN
  IF v_request_id IS NULL OR v_user_id IS NULL OR v_prompt IS NULL OR v_model_id IS NULL THEN
    RAISE EXCEPTION 'request_id, user_id, prompt and model_id are required';
  END IF;

  IF jsonb_typeof(v_reference_assets) <> 'array' THEN
    RAISE EXCEPTION 'reference_assets must be an array';
  END IF;

  INSERT INTO public.generations (
    id,
    user_id,
    type,
    mode,
    prompt,
    model_id,
    preset_id,
    settings,
    reference_assets,
    project_id,
    chat_id,
    message_id,
    status
  )
  VALUES (
    v_request_id,
    v_user_id,
    'image',
    v_mode,
    v_prompt,
    v_model_id,
    v_preset_id,
    v_settings,
    v_reference_assets,
    v_project_id,
    v_chat_id,
    v_message_id,
    'queued'
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_generation;

  IF NOT FOUND THEN
    SELECT *
    INTO v_generation
    FROM public.generations
    WHERE id = v_request_id;

    IF NOT FOUND
       OR v_generation.user_id IS DISTINCT FROM v_user_id
       OR v_generation.type IS DISTINCT FROM 'image' THEN
      RAISE EXCEPTION 'request_id collision with another generation';
    END IF;

    IF v_generation.factory_job_id IS NULL THEN
      RAISE EXCEPTION 'duplicate image generation is missing durable factory_job_id';
    END IF;

    SELECT *
    INTO v_action
    FROM public.agent_actions
    WHERE generation_id = v_generation.id
      AND action_type = 'generate_image'
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_action.id IS NULL THEN
      RAISE EXCEPTION 'duplicate image generation is missing durable agent action';
    END IF;

    RETURN jsonb_build_object(
      'generation', to_jsonb(v_generation),
      'action', to_jsonb(v_action),
      'factory_job_id', v_generation.factory_job_id,
      'duplicate', true,
      'queue_msg_id', NULL
    );
  END IF;

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
    'generation_image',
    1,
    'queued',
    'provider_image',
    0,
    jsonb_build_object('generation_id', v_generation.id),
    jsonb_build_object(
      'generation_id', v_generation.id,
      'variant_index', 0,
      'outputs', '[]'::JSONB
    ),
    NOW()
  )
  RETURNING id INTO v_job_id;

  UPDATE public.generations
  SET factory_job_id = v_job_id
  WHERE id = v_generation.id
  RETURNING * INTO v_generation;

  INSERT INTO public.agent_actions (
    agent_run_id,
    user_id,
    chat_id,
    project_id,
    generation_id,
    source_message_id,
    action_type,
    status,
    input
  )
  VALUES (
    v_agent_run_id,
    v_user_id,
    v_chat_id,
    v_project_id,
    v_generation.id,
    v_message_id,
    'generate_image',
    'dispatched',
    v_action_input
  )
  RETURNING * INTO v_action;

  SELECT msg_id
  INTO v_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object(
      'v', 1,
      'job_id', v_job_id,
      'reason', 'generation_created',
      'trace_id', v_trace_id
    ),
    0
  ) AS msg_id;

  UPDATE public.factory_jobs
  SET last_enqueued_at = NOW()
  WHERE id = v_job_id;

  INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
  VALUES (
    v_job_id,
    'job.enqueued',
    'queue:enqueued:' || v_msg_id::TEXT,
    jsonb_build_object(
      'queue', 'core_orchestrator_v1',
      'queue_msg_id', v_msg_id,
      'reason', 'generation_created',
      'generation_id', v_generation.id,
      'trace_id', v_trace_id
    )
  );

  RETURN jsonb_build_object(
    'generation', to_jsonb(v_generation),
    'action', to_jsonb(v_action),
    'factory_job_id', v_job_id,
    'duplicate', false,
    'queue_msg_id', v_msg_id,
    'trace_id', v_trace_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_create_image_generation(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_create_image_generation(JSONB)
  TO service_role;
