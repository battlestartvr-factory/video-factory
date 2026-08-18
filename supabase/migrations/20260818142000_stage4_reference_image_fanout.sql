-- Stage 4 / S4-005a: durable gameplay reference-image fan-out and human approval reconciliation.
-- Reference images are allowed before approval; VIDEO remains locked until a human approves the exact reference generation.

CREATE OR REPLACE FUNCTION public.orchestrator_create_gameplay_reference_image(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_root_job_id UUID := NULLIF(payload->>'root_job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_request_id UUID := NULLIF(payload->>'request_id', '')::UUID;
  v_concept_id TEXT := NULLIF(trim(payload->>'concept_id'), '');
  v_moment_id TEXT := NULLIF(trim(payload->>'moment_id'), '');
  v_shot_id TEXT := NULLIF(trim(payload->>'shot_id'), '');
  v_prompt TEXT := NULLIF(trim(payload->>'prompt'), '');
  v_model_id TEXT := COALESCE(NULLIF(trim(payload->>'model_id'), ''), 'nano-banana-2');
  v_settings JSONB := COALESCE(payload->'settings', '{}'::JSONB);
  v_root public.creative_runs%ROWTYPE;
  v_concept public.creative_runs%ROWTYPE;
  v_generation_result JSONB;
  v_generation_id UUID;
  v_child_job_id UUID;
  v_request_entry JSONB;
BEGIN
  IF v_root_job_id IS NULL OR v_root_run_id IS NULL OR v_request_id IS NULL
     OR v_concept_id IS NULL OR v_moment_id IS NULL OR v_shot_id IS NULL OR v_prompt IS NULL THEN
    RAISE EXCEPTION 'root_job_id, root_creative_run_id, request_id, concept_id, moment_id, shot_id and prompt are required';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_root_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root/job mismatch'; END IF;

  SELECT * INTO v_concept
  FROM public.creative_runs
  WHERE parent_run_id = v_root_run_id
    AND metadata->>'domain_kind' = 'coop_game_concept'
    AND metadata->>'concept_id' = v_concept_id
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'concept run not found for %', v_concept_id; END IF;

  IF v_concept.outputs->'gameplay_shot'->>'shotId' IS DISTINCT FROM v_shot_id THEN
    RAISE EXCEPTION 'shot % is not the active planned shot for concept %', v_shot_id, v_concept_id;
  END IF;
  IF v_concept.outputs->'prompt_plan'->>'shotId' IS DISTINCT FROM v_shot_id THEN
    RAISE EXCEPTION 'prompt plan is not aligned to shot %', v_shot_id;
  END IF;

  SELECT public.orchestrator_create_image_generation(
    jsonb_build_object(
      'request_id', v_request_id,
      'user_id', v_root.user_id,
      'project_id', v_root.project_id,
      'prompt', v_prompt,
      'model_id', v_model_id,
      'mode', 'text-to-image',
      'settings', v_settings || jsonb_build_object(
        'aspectRatio', '9:16',
        'effectiveQuality', '1K',
        'stage4_reference', true,
        'root_creative_run_id', v_root_run_id,
        'concept_id', v_concept_id,
        'moment_id', v_moment_id,
        'shot_id', v_shot_id
      ),
      'reference_assets', '[]'::JSONB,
      'action_input', jsonb_build_object(
        'source', 'stage4_game_discovery_reference',
        'root_creative_run_id', v_root_run_id,
        'concept_run_id', v_concept.id,
        'concept_id', v_concept_id,
        'moment_id', v_moment_id,
        'shot_id', v_shot_id,
        'video_generation_locked', true
      )
    )
  ) INTO v_generation_result;

  v_generation_id := NULLIF(v_generation_result#>>'{generation,id}', '')::UUID;
  v_child_job_id := NULLIF(v_generation_result->>'factory_job_id', '')::UUID;
  IF v_generation_id IS NULL OR v_child_job_id IS NULL THEN
    RAISE EXCEPTION 'durable reference image admission returned no generation/job id';
  END IF;

  UPDATE public.factory_jobs
  SET parent_job_id = v_root_job_id,
      input = COALESCE(input, '{}'::JSONB) || jsonb_build_object(
        'parent_job_id', v_root_job_id,
        'root_creative_run_id', v_root_run_id,
        'concept_run_id', v_concept.id,
        'concept_id', v_concept_id,
        'moment_id', v_moment_id,
        'shot_id', v_shot_id,
        'stage4_reference', true
      ),
      state = COALESCE(state, '{}'::JSONB) || jsonb_build_object(
        'parent_job_id', v_root_job_id,
        'root_creative_run_id', v_root_run_id,
        'concept_id', v_concept_id,
        'moment_id', v_moment_id,
        'shot_id', v_shot_id,
        'stage4_reference', true
      )
  WHERE id = v_child_job_id;

  v_request_entry := jsonb_build_object(
    'request_id', v_request_id,
    'generation_id', v_generation_id,
    'factory_job_id', v_child_job_id,
    'concept_run_id', v_concept.id,
    'concept_id', v_concept_id,
    'moment_id', v_moment_id,
    'shot_id', v_shot_id,
    'model_id', v_model_id,
    'created_at', NOW()
  );

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
    'reference_image_requests',
    COALESCE(outputs->'reference_image_requests', '{}'::JSONB) || jsonb_build_object(v_shot_id, v_request_entry)
  )
  WHERE id = v_root_run_id;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
    'reference_image_request', v_request_entry
  )
  WHERE id = v_concept.id;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload, creative_run_id)
  VALUES (
    v_root_job_id,
    'discovery.reference_image_admitted',
    'stage4:reference-image:' || v_request_id::TEXT,
    v_request_entry || jsonb_build_object('video_generation_locked', true),
    v_root_run_id
  )
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN v_generation_result || jsonb_build_object(
    'root_job_id', v_root_job_id,
    'concept_run_id', v_concept.id,
    'concept_id', v_concept_id,
    'moment_id', v_moment_id,
    'shot_id', v_shot_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.orchestrator_create_gameplay_reference_image(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_create_gameplay_reference_image(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_get_gameplay_reference_image_stage(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_root public.creative_runs%ROWTYPE;
  v_items JSONB;
BEGIN
  IF v_root_run_id IS NULL THEN RAISE EXCEPTION 'root_creative_run_id is required'; END IF;
  SELECT * INTO v_root FROM public.creative_runs
  WHERE id = v_root_run_id AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found'; END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY shot_id), '[]'::JSONB)
  INTO v_items
  FROM (
    SELECT req.key AS shot_id,
      jsonb_build_object(
        'shot_id', req.key,
        'concept_id', req.value->>'concept_id',
        'moment_id', req.value->>'moment_id',
        'concept_run_id', req.value->>'concept_run_id',
        'generation_id', g.id,
        'factory_job_id', g.factory_job_id,
        'status', g.status,
        'outputs', COALESCE(g.outputs, '[]'::JSONB),
        'error_message', g.error_message,
        'model_id', g.model_id,
        'created_at', g.created_at,
        'completed_at', g.completed_at
      ) AS item
    FROM jsonb_each(COALESCE(v_root.outputs->'reference_image_requests', '{}'::JSONB)) req
    LEFT JOIN public.generations g ON g.id = NULLIF(req.value->>'generation_id', '')::UUID
  ) rows;

  RETURN jsonb_build_object(
    'items', v_items,
    'request_count', jsonb_array_length(v_items),
    'all_terminal', NOT EXISTS (
      SELECT 1
      FROM jsonb_each(COALESCE(v_root.outputs->'reference_image_requests', '{}'::JSONB)) req
      LEFT JOIN public.generations g ON g.id = NULLIF(req.value->>'generation_id', '')::UUID
      WHERE g.id IS NULL OR g.status NOT IN ('completed', 'failed', 'cancelled')
    ),
    'all_completed', jsonb_array_length(v_items) > 0 AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(COALESCE(v_root.outputs->'reference_image_requests', '{}'::JSONB)) req
      LEFT JOIN public.generations g ON g.id = NULLIF(req.value->>'generation_id', '')::UUID
      WHERE g.id IS NULL OR g.status <> 'completed'
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.orchestrator_get_gameplay_reference_image_stage(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_gameplay_reference_image_stage(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_get_gameplay_reference_approval_stage(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_root public.creative_runs%ROWTYPE;
  v_items JSONB;
BEGIN
  IF v_root_run_id IS NULL THEN RAISE EXCEPTION 'root_creative_run_id is required'; END IF;
  SELECT * INTO v_root FROM public.creative_runs
  WHERE id = v_root_run_id AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found'; END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY shot_id), '[]'::JSONB)
  INTO v_items
  FROM (
    SELECT req.key AS shot_id,
      jsonb_build_object(
        'shot_id', req.key,
        'concept_id', req.value->>'concept_id',
        'moment_id', req.value->>'moment_id',
        'concept_run_id', req.value->>'concept_run_id',
        'generation_id', g.id,
        'generation_status', g.status,
        'outputs', COALESCE(g.outputs, '[]'::JSONB),
        'review_id', review.id,
        'decision', review.decision,
        'raw_feedback', review.raw_feedback,
        'structured_feedback', review.structured_feedback,
        'reviewed_at', review.created_at
      ) AS item
    FROM jsonb_each(COALESCE(v_root.outputs->'reference_image_requests', '{}'::JSONB)) req
    LEFT JOIN public.generations g ON g.id = NULLIF(req.value->>'generation_id', '')::UUID
    LEFT JOIN LATERAL (
      SELECT r.* FROM public.gameplay_reference_reviews r
      WHERE r.root_creative_run_id = v_root_run_id
        AND r.generation_id = g.id
      ORDER BY r.created_at DESC
      LIMIT 1
    ) review ON TRUE
  ) rows;

  RETURN jsonb_build_object(
    'items', v_items,
    'all_reviewed', jsonb_array_length(v_items) > 0 AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(COALESCE(v_root.outputs->'reference_image_requests', '{}'::JSONB)) req
      LEFT JOIN public.generations g ON g.id = NULLIF(req.value->>'generation_id', '')::UUID
      LEFT JOIN LATERAL (
        SELECT r.id FROM public.gameplay_reference_reviews r
        WHERE r.root_creative_run_id = v_root_run_id AND r.generation_id = g.id
        ORDER BY r.created_at DESC LIMIT 1
      ) review ON TRUE
      WHERE g.status = 'completed' AND review.id IS NULL
    ),
    'all_approved', jsonb_array_length(v_items) > 0 AND NOT EXISTS (
      SELECT 1
      FROM jsonb_each(COALESCE(v_root.outputs->'reference_image_requests', '{}'::JSONB)) req
      LEFT JOIN public.generations g ON g.id = NULLIF(req.value->>'generation_id', '')::UUID
      LEFT JOIN LATERAL (
        SELECT r.decision FROM public.gameplay_reference_reviews r
        WHERE r.root_creative_run_id = v_root_run_id AND r.generation_id = g.id
        ORDER BY r.created_at DESC LIMIT 1
      ) review ON TRUE
      WHERE g.status <> 'completed' OR review.decision IS DISTINCT FROM 'approve'
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.orchestrator_get_gameplay_reference_approval_stage(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_gameplay_reference_approval_stage(JSONB) TO service_role;

-- Replace review recorder so a human decision wakes the parked parent discovery job.
CREATE OR REPLACE FUNCTION public.orchestrator_record_gameplay_reference_review(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_concept_run_id UUID := NULLIF(payload->>'concept_run_id', '')::UUID;
  v_generation_id UUID := NULLIF(payload->>'generation_id', '')::UUID;
  v_user_id UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_decision TEXT := NULLIF(trim(payload->>'decision'), '');
  v_structured JSONB := COALESCE(payload->'structured_feedback', '{}'::JSONB);
  v_review public.gameplay_reference_reviews%ROWTYPE;
  v_root public.creative_runs%ROWTYPE;
  v_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
BEGIN
  IF v_root_run_id IS NULL OR v_concept_run_id IS NULL OR v_generation_id IS NULL OR v_decision IS NULL THEN
    RAISE EXCEPTION 'root_creative_run_id, concept_run_id, generation_id and decision are required';
  END IF;
  IF v_decision NOT IN ('approve', 'reject', 'revise') THEN RAISE EXCEPTION 'invalid decision'; END IF;

  SELECT * INTO v_root FROM public.creative_runs
  WHERE id = v_root_run_id AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND OR v_root.factory_job_id IS NULL THEN RAISE EXCEPTION 'game discovery root/job not found'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.creative_runs cr
    WHERE cr.id = v_concept_run_id AND cr.parent_run_id = v_root_run_id
      AND cr.metadata->>'domain_kind' = 'coop_game_concept'
  ) THEN RAISE EXCEPTION 'concept run is not a child of discovery root'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.generations g
    JOIN public.factory_jobs fj ON fj.id = g.factory_job_id
    WHERE g.id = v_generation_id AND fj.parent_job_id = v_root.factory_job_id
      AND COALESCE((g.settings->>'stage4_reference')::BOOLEAN, false) = true
  ) THEN RAISE EXCEPTION 'generation is not a Stage 4 reference child'; END IF;

  INSERT INTO public.gameplay_reference_reviews (
    root_creative_run_id, concept_run_id, generation_id, user_id,
    concept_id, moment_id, shot_id, decision, raw_feedback,
    structured_feedback, error_tags, must_show, must_avoid, reusable_scope, model, usage
  ) VALUES (
    v_root_run_id, v_concept_run_id, v_generation_id, v_user_id,
    NULLIF(trim(payload->>'concept_id'), ''), NULLIF(trim(payload->>'moment_id'), ''),
    NULLIF(trim(payload->>'shot_id'), ''), v_decision, NULLIF(payload->>'raw_feedback', ''),
    v_structured, COALESCE(v_structured->'errorTags', '[]'::JSONB),
    COALESCE(v_structured->'mustShow', '[]'::JSONB), COALESCE(v_structured->'mustAvoid', '[]'::JSONB),
    COALESCE(NULLIF(v_structured->>'reusableScope', ''), 'concept'),
    NULLIF(trim(payload->>'model'), ''), COALESCE(payload->'usage', '{}'::JSONB)
  )
  ON CONFLICT (generation_id, user_id)
    WHERE generation_id IS NOT NULL AND user_id IS NOT NULL
  DO UPDATE SET
    decision = EXCLUDED.decision,
    raw_feedback = EXCLUDED.raw_feedback,
    structured_feedback = EXCLUDED.structured_feedback,
    error_tags = EXCLUDED.error_tags,
    must_show = EXCLUDED.must_show,
    must_avoid = EXCLUDED.must_avoid,
    reusable_scope = EXCLUDED.reusable_scope,
    model = EXCLUDED.model,
    usage = EXCLUDED.usage,
    created_at = NOW()
  RETURNING * INTO v_review;

  SELECT msg_id INTO v_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object(
      'v', 1,
      'job_id', v_root.factory_job_id,
      'reason', 'human_reference_review',
      'trace_id', v_trace_id
    ),
    0
  ) AS msg_id;
  UPDATE public.factory_jobs SET last_enqueued_at = NOW() WHERE id = v_root.factory_job_id;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload, creative_run_id)
  VALUES (
    v_root.factory_job_id,
    'discovery.reference_review_recorded',
    'stage4:reference-review:' || v_review.id::TEXT || ':' || extract(epoch from v_review.created_at)::BIGINT::TEXT,
    jsonb_build_object(
      'review_id', v_review.id,
      'generation_id', v_generation_id,
      'shot_id', v_review.shot_id,
      'decision', v_decision,
      'queue_msg_id', v_msg_id,
      'trace_id', v_trace_id
    ),
    v_root_run_id
  ) ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('review', to_jsonb(v_review), 'queue_msg_id', v_msg_id, 'trace_id', v_trace_id);
END;
$$;
REVOKE ALL ON FUNCTION public.orchestrator_record_gameplay_reference_review(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_gameplay_reference_review(JSONB) TO service_role;
