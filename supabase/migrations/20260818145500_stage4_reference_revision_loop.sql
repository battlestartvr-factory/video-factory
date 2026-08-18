-- Stage 4 / S4-005a: targeted, idempotent reference revision after human feedback.
-- Only shots explicitly marked revise are invalidated; approved references remain reusable.

CREATE OR REPLACE FUNCTION public.orchestrator_prepare_gameplay_reference_revision(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_revision_key TEXT := NULLIF(trim(payload->>'revision_key'), '');
  v_shot_ids JSONB := COALESCE(payload->'shot_ids', '[]'::JSONB);
  v_root public.creative_runs%ROWTYPE;
  v_requests JSONB;
  v_removed JSONB := '{}'::JSONB;
  v_shot_id TEXT;
  v_revision INTEGER;
BEGIN
  IF v_root_run_id IS NULL OR v_revision_key IS NULL THEN
    RAISE EXCEPTION 'root_creative_run_id and revision_key are required';
  END IF;
  IF jsonb_typeof(v_shot_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(v_shot_ids) = 0 THEN
    RAISE EXCEPTION 'shot_ids must be a non-empty array';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id AND metadata->>'domain_kind' = 'game_discovery_batch'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found'; END IF;

  v_revision := COALESCE((v_root.outputs->>'reference_revision_number')::INTEGER, 0);
  IF v_root.outputs->>'last_reference_revision_key' = v_revision_key THEN
    RETURN jsonb_build_object('revision_number', v_revision, 'duplicate', true);
  END IF;

  v_requests := COALESCE(v_root.outputs->'reference_image_requests', '{}'::JSONB);
  FOR v_shot_id IN SELECT value #>> '{}' FROM jsonb_array_elements(v_shot_ids)
  LOOP
    IF v_requests ? v_shot_id THEN
      v_removed := v_removed || jsonb_build_object(v_shot_id, v_requests->v_shot_id);
      v_requests := v_requests - v_shot_id;
    END IF;
  END LOOP;
  v_revision := v_revision + 1;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB)
    || jsonb_build_object(
      'reference_image_requests', v_requests,
      'reference_revision_number', v_revision,
      'last_reference_revision_key', v_revision_key,
      'reference_revision_history',
        COALESCE(outputs->'reference_revision_history', '[]'::JSONB)
        || jsonb_build_array(jsonb_build_object(
          'revision_number', v_revision,
          'revision_key', v_revision_key,
          'shot_ids', v_shot_ids,
          'previous_requests', v_removed,
          'prepared_at', NOW()
        ))
    )
  WHERE id = v_root_run_id;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) - 'reference_image_request'
  WHERE parent_run_id = v_root_run_id
    AND metadata->>'domain_kind' = 'coop_game_concept'
    AND outputs->'gameplay_shot'->>'shotId' IN (
      SELECT value #>> '{}' FROM jsonb_array_elements(v_shot_ids)
    );

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload, creative_run_id)
  SELECT
    v_root.factory_job_id,
    'discovery.reference_revision_prepared',
    'stage4:reference-revision:' || v_revision_key,
    jsonb_build_object(
      'revision_number', v_revision,
      'revision_key', v_revision_key,
      'shot_ids', v_shot_ids,
      'invalidated_request_count', (SELECT count(*) FROM jsonb_each(v_removed))
    ),
    v_root_run_id
  WHERE v_root.factory_job_id IS NOT NULL
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('revision_number', v_revision, 'duplicate', false);
END;
$$;
REVOKE ALL ON FUNCTION public.orchestrator_prepare_gameplay_reference_revision(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_prepare_gameplay_reference_revision(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_get_game_discovery_visual_stage(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_root public.creative_runs%ROWTYPE;
BEGIN
  IF v_root_run_id IS NULL THEN RAISE EXCEPTION 'root_creative_run_id is required'; END IF;
  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found'; END IF;

  RETURN jsonb_build_object(
    'gameplay_shots', COALESCE(v_root.outputs->'gameplay_shots', '[]'::JSONB),
    'prompt_plans', COALESCE(v_root.outputs->'prompt_plans', '[]'::JSONB),
    'shot_planner_metadata', COALESCE(v_root.outputs->'shot_planner_metadata', '{}'::JSONB),
    'prompt_compiler_metadata', COALESCE(v_root.outputs->'prompt_compiler_metadata', '{}'::JSONB),
    'reference_approval_required', COALESCE((v_root.outputs->>'reference_approval_required')::BOOLEAN, false),
    'reference_revision_number', COALESCE((v_root.outputs->>'reference_revision_number')::INTEGER, 0),
    'last_reference_revision_key', v_root.outputs->>'last_reference_revision_key'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.orchestrator_get_game_discovery_visual_stage(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_game_discovery_visual_stage(JSONB) TO service_role;
