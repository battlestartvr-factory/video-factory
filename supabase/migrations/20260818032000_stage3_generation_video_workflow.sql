-- Stage 3: durable video generation workflow (generation_video@1).
-- Admission is atomic; paid provider execution stays exclusively in the durable worker.
-- Video cost estimates are intentionally not guessed. Provider credits/actual cost, when
-- present, are still preserved by the shared accounting path.

CREATE OR REPLACE FUNCTION public.orchestrator_create_video_generation(payload JSONB)
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
  v_mode TEXT := COALESCE(NULLIF(trim(payload->>'mode'), ''), 'text-to-video');
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
    id, user_id, type, mode, prompt, model_id, preset_id, settings,
    reference_assets, project_id, chat_id, message_id, status
  )
  VALUES (
    v_request_id, v_user_id, 'video', v_mode, v_prompt, v_model_id, v_preset_id,
    v_settings, v_reference_assets, v_project_id, v_chat_id, v_message_id, 'queued'
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_generation;

  IF NOT FOUND THEN
    SELECT * INTO v_generation
    FROM public.generations
    WHERE id = v_request_id;

    IF NOT FOUND
       OR v_generation.user_id IS DISTINCT FROM v_user_id
       OR v_generation.type IS DISTINCT FROM 'video' THEN
      RAISE EXCEPTION 'request_id collision with another generation';
    END IF;

    IF v_generation.factory_job_id IS NULL THEN
      RAISE EXCEPTION 'duplicate video generation is missing durable factory_job_id';
    END IF;

    SELECT * INTO v_action
    FROM public.agent_actions
    WHERE generation_id = v_generation.id
      AND action_type = 'generate_video'
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_action.id IS NULL THEN
      RAISE EXCEPTION 'duplicate video generation is missing durable agent action';
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
    request_id, project_id, user_id, workflow_kind, workflow_version, status,
    current_stage, progress, input, state, next_action_at
  )
  VALUES (
    v_request_id,
    v_project_id,
    v_user_id,
    'generation_video',
    1,
    'queued',
    'provider_video',
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
    agent_run_id, user_id, chat_id, project_id, generation_id, source_message_id,
    action_type, status, input
  )
  VALUES (
    v_agent_run_id, v_user_id, v_chat_id, v_project_id, v_generation.id,
    v_message_id, 'generate_video', 'dispatched', v_action_input
  )
  RETURNING * INTO v_action;

  SELECT msg_id INTO v_msg_id
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

REVOKE ALL ON FUNCTION public.orchestrator_create_video_generation(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_create_video_generation(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_get_video_generation(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_generation public.generations%ROWTYPE;
  v_action_id UUID;
BEGIN
  SELECT g.* INTO v_generation
  FROM public.generations AS g
  WHERE g.factory_job_id = p_job_id
    AND g.type = 'video';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT aa.id INTO v_action_id
  FROM public.agent_actions AS aa
  WHERE aa.generation_id = v_generation.id
    AND aa.action_type = 'generate_video'
  ORDER BY aa.created_at ASC
  LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'generation', to_jsonb(v_generation),
    'action_id', v_action_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_video_generation(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_video_generation(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_mark_video_generation_processing(
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
    SELECT 1 FROM public.provider_tasks pt
    WHERE pt.id = p_provider_task_id
      AND pt.job_id = p_job_id
  ) THEN
    RAISE EXCEPTION 'provider task does not belong to video generation job';
  END IF;

  UPDATE public.generations
  SET
    status = CASE WHEN status IN ('pending', 'queued') THEN 'processing' ELSE status END,
    error_message = CASE WHEN status IN ('pending', 'queued') THEN NULL ELSE error_message END
  WHERE factory_job_id = p_job_id
    AND type = 'video'
    AND status NOT IN ('completed', 'failed', 'cancelled')
  RETURNING id INTO v_generation_id;

  IF v_generation_id IS NULL THEN
    SELECT id INTO v_generation_id
    FROM public.generations
    WHERE factory_job_id = p_job_id AND type = 'video';
  END IF;

  IF v_generation_id IS NULL THEN RETURN false; END IF;

  UPDATE public.agent_actions
  SET
    status = CASE WHEN status IN ('pending_dispatch', 'dispatched') THEN 'processing' ELSE status END,
    error_code = CASE WHEN status IN ('pending_dispatch', 'dispatched') THEN NULL ELSE error_code END,
    error_message = CASE WHEN status IN ('pending_dispatch', 'dispatched') THEN NULL ELSE error_message END
  WHERE generation_id = v_generation_id
    AND action_type = 'generate_video'
    AND status NOT IN ('completed', 'failed', 'cancelled');

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_mark_video_generation_processing(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_mark_video_generation_processing(UUID, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_complete_video_generation(
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
    SELECT 1 FROM public.provider_tasks pt
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
    AND type = 'video'
    AND status <> 'cancelled'
  RETURNING id INTO v_generation_id;

  IF v_generation_id IS NULL THEN RETURN false; END IF;

  UPDATE public.agent_actions
  SET
    status = 'completed',
    output = jsonb_build_object('outputs', COALESCE(p_outputs, '[]'::JSONB)),
    error_code = NULL,
    error_message = NULL,
    finished_at = COALESCE(finished_at, NOW())
  WHERE generation_id = v_generation_id
    AND action_type = 'generate_video'
    AND status <> 'cancelled';

  INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
  VALUES (
    p_job_id,
    'generation.completed',
    'generation:video:completed:' || v_generation_id::TEXT,
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

REVOKE ALL ON FUNCTION public.orchestrator_complete_video_generation(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_complete_video_generation(UUID, UUID, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_fail_video_generation(
  p_job_id UUID,
  p_provider_task_id UUID DEFAULT NULL,
  p_error_code TEXT DEFAULT 'GENERATION_FAILED',
  p_error_message TEXT DEFAULT 'Video generation failed'
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
    SELECT 1 FROM public.provider_tasks pt
    WHERE pt.id = p_provider_task_id
      AND pt.job_id = p_job_id
  ) THEN
    RAISE EXCEPTION 'provider task does not belong to video generation job';
  END IF;

  UPDATE public.generations
  SET
    status = 'failed',
    error_message = COALESCE(NULLIF(p_error_message, ''), 'Video generation failed'),
    completed_at = COALESCE(completed_at, NOW())
  WHERE factory_job_id = p_job_id
    AND type = 'video'
    AND status NOT IN ('completed', 'cancelled')
  RETURNING id INTO v_generation_id;

  IF v_generation_id IS NULL THEN
    SELECT id INTO v_generation_id
    FROM public.generations
    WHERE factory_job_id = p_job_id AND type = 'video';
  END IF;

  IF v_generation_id IS NULL THEN RETURN false; END IF;

  UPDATE public.agent_actions
  SET
    status = 'failed',
    error_code = COALESCE(NULLIF(p_error_code, ''), 'GENERATION_FAILED'),
    error_message = COALESCE(NULLIF(p_error_message, ''), 'Video generation failed'),
    finished_at = COALESCE(finished_at, NOW())
  WHERE generation_id = v_generation_id
    AND action_type = 'generate_video'
    AND status NOT IN ('completed', 'cancelled');

  INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
  VALUES (
    p_job_id,
    'generation.failed',
    'generation:video:failed:' || v_generation_id::TEXT,
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

REVOKE ALL ON FUNCTION public.orchestrator_fail_video_generation(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_fail_video_generation(UUID, UUID, TEXT, TEXT)
  TO service_role;

-- Extend the shared provider accounting sink to durable video jobs. No video list-price
-- estimate is introduced here: missing price remains an explicit zero placeholder while
-- credits/actual provider cost can still reconcile onto the same deduped event.
CREATE OR REPLACE FUNCTION public.orchestrator_sync_provider_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workflow_kind TEXT;
  v_capability TEXT;
  v_failed_task_cost NUMERIC(12, 6);
  v_effective_cost NUMERIC(12, 6);
  v_is_estimated BOOLEAN;
  v_cost_basis TEXT;
  v_job_effective_cost NUMERIC(12, 6);
  v_job_actual_cost NUMERIC(12, 6);
BEGIN
  SELECT fj.workflow_kind INTO v_workflow_kind
  FROM public.factory_jobs fj
  WHERE fj.id = NEW.job_id;

  IF v_workflow_kind NOT IN ('generation_image', 'generation_video') THEN
    RETURN NEW;
  END IF;

  v_capability := CASE WHEN v_workflow_kind = 'generation_video' THEN 'video' ELSE 'image' END;

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
    job_id, stage_id, provider_task_id, provider, model, capability,
    units, credits, cost_usd, estimated, creative_run_id, dedupe_key
  )
  VALUES (
    NEW.job_id,
    NEW.stage_id,
    NEW.id,
    NEW.provider,
    NEW.model,
    v_capability,
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
  SET estimated_cost_usd = v_job_effective_cost,
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
