-- Stage 3 / S3-005: first real durable generation workflow (generation_image@1).
--
-- The API request, durable factory job and first queue wake are created in one DB
-- transaction. Provider execution remains exclusively in the durable worker.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS factory_job_id UUID;

ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS generations_factory_job_id_fkey;
ALTER TABLE public.generations
  ADD CONSTRAINT generations_factory_job_id_fkey
    FOREIGN KEY (factory_job_id) REFERENCES public.factory_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_factory_job_id
  ON public.generations (factory_job_id)
  WHERE factory_job_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Atomic image-generation admission: generation + action + durable job + queue.
-- request_id is also used as the generation UUID so the whole operation is naturally
-- idempotent if the same request is replayed.
-- ---------------------------------------------------------------------------
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
  v_preset_id TEXT := NULLIF(trim(payload->>'preset_id'), '');
  v_mode TEXT := COALESCE(NULLIF(trim(payload->>'mode'), ''), 'text_to_image');
  v_settings JSONB := COALESCE(payload->'settings', '{}'::JSONB);
  v_reference_assets JSONB := COALESCE(payload->'reference_assets', '[]'::JSONB);
  v_action_input JSONB := COALESCE(payload->'action_input', '{}'::JSONB);
  v_generation public.generations%ROWTYPE;
  v_action public.agent_actions%ROWTYPE;
  v_job_id UUID;
  v_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
  v_duplicate BOOLEAN := false;
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
    v_duplicate := true;
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

    RETURN jsonb_build_object(
      'generation', to_jsonb(v_generation),
      'action', CASE WHEN v_action.id IS NULL THEN NULL ELSE to_jsonb(v_action) END,
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
    'duplicate', v_duplicate,
    'queue_msg_id', v_msg_id,
    'trace_id', v_trace_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_create_image_generation(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_create_image_generation(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Worker-facing generation projection. The durable worker never needs broad table
-- access semantics; it asks for the generation attached to its claimed factory job.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_get_image_generation(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_action_id UUID;
BEGIN
  SELECT g.*
  INTO v_generation
  FROM public.generations AS g
  WHERE g.factory_job_id = p_job_id
    AND g.type = 'image';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT aa.id
  INTO v_action_id
  FROM public.agent_actions AS aa
  WHERE aa.generation_id = v_generation.id
    AND aa.action_type = 'generate_image'
  ORDER BY aa.created_at ASC
  LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'generation', to_jsonb(v_generation),
    'action_id', v_action_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_image_generation(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_image_generation(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_mark_image_generation_processing(
  p_job_id UUID,
  p_provider_task_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.provider_tasks pt
    WHERE pt.id = p_provider_task_id
      AND pt.job_id = p_job_id
  ) THEN
    RAISE EXCEPTION 'provider task does not belong to image generation job';
  END IF;

  UPDATE public.generations
  SET
    status = CASE WHEN status IN ('pending', 'queued') THEN 'processing' ELSE status END,
    error_message = CASE WHEN status IN ('pending', 'queued') THEN NULL ELSE error_message END
  WHERE factory_job_id = p_job_id
    AND type = 'image'
    AND status NOT IN ('completed', 'failed', 'cancelled')
  RETURNING id INTO v_generation_id;

  IF v_generation_id IS NULL THEN
    SELECT id INTO v_generation_id
    FROM public.generations
    WHERE factory_job_id = p_job_id AND type = 'image';
  END IF;

  IF v_generation_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.agent_actions
  SET
    status = CASE WHEN status IN ('pending_dispatch', 'dispatched') THEN 'processing' ELSE status END,
    error_code = CASE WHEN status IN ('pending_dispatch', 'dispatched') THEN NULL ELSE error_code END,
    error_message = CASE WHEN status IN ('pending_dispatch', 'dispatched') THEN NULL ELSE error_message END
  WHERE generation_id = v_generation_id
    AND action_type = 'generate_image'
    AND status NOT IN ('completed', 'failed', 'cancelled');

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_mark_image_generation_processing(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_mark_image_generation_processing(UUID, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_complete_image_generation(
  p_job_id UUID,
  p_provider_task_id UUID,
  p_outputs JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation_id UUID;
BEGIN
  IF jsonb_typeof(COALESCE(p_outputs, '[]'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'outputs must be an array';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.provider_tasks pt
    WHERE pt.id = p_provider_task_id
      AND pt.job_id = p_job_id
      AND pt.status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'successful provider task required to complete generation';
  END IF;

  UPDATE public.generations
  SET
    status = 'completed',
    outputs = COALESCE(p_outputs, '[]'::JSONB),
    error_message = NULL,
    completed_at = COALESCE(completed_at, NOW())
  WHERE factory_job_id = p_job_id
    AND type = 'image'
    AND status <> 'cancelled'
  RETURNING id INTO v_generation_id;

  IF v_generation_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.agent_actions
  SET
    status = 'completed',
    output = jsonb_build_object('outputs', COALESCE(p_outputs, '[]'::JSONB)),
    error_code = NULL,
    error_message = NULL,
    finished_at = COALESCE(finished_at, NOW())
  WHERE generation_id = v_generation_id
    AND action_type = 'generate_image'
    AND status <> 'cancelled';

  INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
  VALUES (
    p_job_id,
    'generation.completed',
    'generation:image:completed:' || v_generation_id::TEXT,
    jsonb_build_object(
      'generation_id', v_generation_id,
      'provider_task_id', p_provider_task_id,
      'output_count', jsonb_array_length(COALESCE(p_outputs, '[]'::JSONB))
    )
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_complete_image_generation(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_complete_image_generation(UUID, UUID, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_fail_image_generation(
  p_job_id UUID,
  p_provider_task_id UUID DEFAULT NULL,
  p_error_code TEXT DEFAULT 'GENERATION_FAILED',
  p_error_message TEXT DEFAULT 'Image generation failed'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation_id UUID;
BEGIN
  IF p_provider_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.provider_tasks pt
    WHERE pt.id = p_provider_task_id
      AND pt.job_id = p_job_id
  ) THEN
    RAISE EXCEPTION 'provider task does not belong to image generation job';
  END IF;

  UPDATE public.generations
  SET
    status = 'failed',
    error_message = COALESCE(NULLIF(p_error_message, ''), 'Image generation failed'),
    completed_at = COALESCE(completed_at, NOW())
  WHERE factory_job_id = p_job_id
    AND type = 'image'
    AND status NOT IN ('completed', 'cancelled')
  RETURNING id INTO v_generation_id;

  IF v_generation_id IS NULL THEN
    SELECT id INTO v_generation_id
    FROM public.generations
    WHERE factory_job_id = p_job_id AND type = 'image';
  END IF;

  IF v_generation_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.agent_actions
  SET
    status = 'failed',
    error_code = COALESCE(NULLIF(p_error_code, ''), 'GENERATION_FAILED'),
    error_message = COALESCE(NULLIF(p_error_message, ''), 'Image generation failed'),
    finished_at = COALESCE(finished_at, NOW())
  WHERE generation_id = v_generation_id
    AND action_type = 'generate_image'
    AND status NOT IN ('completed', 'cancelled');

  INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
  VALUES (
    p_job_id,
    'generation.failed',
    'generation:image:failed:' || v_generation_id::TEXT,
    jsonb_strip_nulls(jsonb_build_object(
      'generation_id', v_generation_id,
      'provider_task_id', p_provider_task_id,
      'error_code', p_error_code,
      'error_message', p_error_message
    ))
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_fail_image_generation(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_fail_image_generation(UUID, UUID, TEXT, TEXT)
  TO service_role;

-- A definitively rejected createTask response is terminal for this provider_task. We do
-- not grant a second automatic paid POST; a user-triggered retry must create a new job.
CREATE OR REPLACE FUNCTION public.orchestrator_record_provider_submit_failure(
  p_provider_task_id UUID,
  p_error JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task public.provider_tasks%ROWTYPE;
BEGIN
  SELECT *
  INTO v_task
  FROM public.provider_tasks
  WHERE id = p_provider_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider task not found';
  END IF;

  IF v_task.external_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'cannot mark submitted provider task as submit failure';
  END IF;

  IF v_task.status NOT IN ('failed', 'cancelled') THEN
    UPDATE public.provider_tasks
    SET
      status = 'failed',
      error = COALESCE(p_error, '{}'::JSONB),
      next_check_at = NULL,
      last_checked_at = NOW()
    WHERE id = p_provider_task_id
    RETURNING * INTO v_task;

    UPDATE public.factory_job_stages
    SET
      status = CASE WHEN status = 'cancelled' THEN status ELSE 'failed' END,
      error = COALESCE(p_error, '{}'::JSONB),
      finished_at = COALESCE(finished_at, NOW())
    WHERE id = v_task.stage_id;
  END IF;

  INSERT INTO public.factory_workflow_events (
    job_id,
    stage_id,
    event_type,
    dedupe_key,
    payload,
    creative_run_id
  )
  VALUES (
    v_task.job_id,
    v_task.stage_id,
    'provider.submit_failed',
    'provider:submit_failed:' || v_task.id::TEXT,
    jsonb_build_object(
      'provider_task_id', v_task.id,
      'provider', v_task.provider,
      'model', v_task.model,
      'error', COALESCE(p_error, '{}'::JSONB)
    ),
    v_task.creative_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'provider_task_id', v_task.id,
    'status', v_task.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_provider_submit_failure(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_provider_submit_failure(UUID, JSONB)
  TO service_role;
