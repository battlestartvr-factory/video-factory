-- Stage 4 / S4-004: cheap concept pre-evaluation + Gameplay Moment persistence.
-- All RPCs are service-role only and idempotent at the creative-run level.

CREATE OR REPLACE FUNCTION public.orchestrator_get_game_discovery_planning_stage(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_root public.creative_runs%ROWTYPE;
BEGIN
  IF v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'root_creative_run_id is required';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'game discovery root creative run not found';
  END IF;

  RETURN jsonb_build_object(
    'pre_evaluations', COALESCE(v_root.outputs->'concept_pre_evaluations', '[]'::JSONB),
    'selected_concept_ids', COALESCE(v_root.outputs->'selected_concept_ids', '[]'::JSONB),
    'gameplay_moments', COALESCE(v_root.outputs->'gameplay_moments', '[]'::JSONB),
    'pre_evaluation_metadata', COALESCE(v_root.outputs->'pre_evaluation_metadata', '{}'::JSONB),
    'moment_planner_metadata', COALESCE(v_root.outputs->'moment_planner_metadata', '{}'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_game_discovery_planning_stage(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_game_discovery_planning_stage(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_persist_game_pre_evaluations(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_evaluations JSONB := COALESCE(payload->'evaluations', '[]'::JSONB);
  v_selected JSONB := COALESCE(payload->'selected_concept_ids', '[]'::JSONB);
  v_metadata JSONB := COALESCE(payload->'metadata', '{}'::JSONB);
  v_model TEXT := COALESCE(NULLIF(trim(payload->>'model'), ''), 'claude-haiku-4-5');
  v_root public.creative_runs%ROWTYPE;
  v_item JSONB;
  v_concept_id TEXT;
  v_child public.creative_runs%ROWTYPE;
  v_pass BOOLEAN;
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'job_id and root_creative_run_id are required';
  END IF;
  IF jsonb_typeof(v_evaluations) IS DISTINCT FROM 'array' OR jsonb_array_length(v_evaluations) = 0 THEN
    RAISE EXCEPTION 'evaluations must be a non-empty array';
  END IF;
  IF jsonb_typeof(v_selected) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'selected_concept_ids must be an array';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'game discovery root creative run not found or job mismatch';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_evaluations)
  LOOP
    IF v_item->>'schema' IS DISTINCT FROM 'concept_pre_evaluation'
       OR v_item->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'unsupported concept_pre_evaluation schema/version';
    END IF;
    v_concept_id := NULLIF(trim(v_item->>'conceptId'), '');
    IF v_concept_id IS NULL THEN
      RAISE EXCEPTION 'pre-evaluation is missing conceptId';
    END IF;

    SELECT * INTO v_child
    FROM public.creative_runs
    WHERE parent_run_id = v_root_run_id
      AND metadata->>'domain_kind' = 'coop_game_concept'
      AND metadata->>'concept_id' = v_concept_id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'concept run not found for %', v_concept_id;
    END IF;

    v_pass := v_item->>'coOpDependency' = 'pass'
      AND v_item->>'instantReadability' = 'pass'
      AND v_item->>'buildability' = 'pass';

    UPDATE public.creative_runs
    SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
      'concept_pre_evaluation', v_item
    )
    WHERE id = v_child.id;

    IF NOT EXISTS (
      SELECT 1 FROM public.creative_evaluations ce
      WHERE ce.run_id = v_child.id
        AND ce.evaluator = 'stage4_pre_evaluator_v1'
    ) THEN
      INSERT INTO public.creative_evaluations (
        run_id,
        user_id,
        evaluator_type,
        evaluator,
        verdict,
        dimensions,
        rationale,
        evidence,
        metadata
      )
      VALUES (
        v_child.id,
        NULL,
        'agent',
        'stage4_pre_evaluator_v1',
        CASE WHEN v_pass THEN 'pass' ELSE 'fail' END,
        jsonb_build_object(
          'co_op_dependency', v_item->>'coOpDependency',
          'instant_readability', v_item->>'instantReadability',
          'buildability', v_item->>'buildability'
        ),
        CASE
          WHEN jsonb_array_length(COALESCE(v_item->'rejectionReasons', '[]'::JSONB)) > 0
            THEN array_to_string(ARRAY(SELECT jsonb_array_elements_text(v_item->'rejectionReasons')), '; ')
          ELSE NULL
        END,
        COALESCE(v_item->'cautionFlags', '[]'::JSONB),
        jsonb_build_object(
          'schema', 'concept_pre_evaluation',
          'version', 1,
          'model', v_model,
          'root_discovery_run_id', v_root_run_id
        )
      );
    END IF;
  END LOOP;

  UPDATE public.creative_runs
  SET
    outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
      'concept_pre_evaluations', v_evaluations,
      'selected_concept_ids', v_selected,
      'pre_evaluation_metadata', v_metadata || jsonb_build_object('model', v_model)
    ),
    usage = COALESCE(usage, '{}'::JSONB) || jsonb_build_object(
      'concept_pre_evaluator', COALESCE(v_metadata->'usage', '{}'::JSONB)
    )
  WHERE id = v_root_run_id;

  INSERT INTO public.factory_workflow_events (
    job_id, event_type, dedupe_key, payload, creative_run_id
  )
  VALUES (
    v_job_id,
    'discovery.pre_evaluations_persisted',
    'stage4:s4-004:pre-evaluations-persisted',
    jsonb_build_object(
      'evaluation_count', jsonb_array_length(v_evaluations),
      'selected_concept_ids', v_selected,
      'model', v_model
    ),
    v_root_run_id
  )
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'evaluation_count', jsonb_array_length(v_evaluations),
    'selected_concept_ids', v_selected
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_game_pre_evaluations(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_game_pre_evaluations(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_persist_gameplay_moments(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_moments JSONB := COALESCE(payload->'moments', '[]'::JSONB);
  v_metadata JSONB := COALESCE(payload->'metadata', '{}'::JSONB);
  v_model TEXT := COALESCE(NULLIF(trim(payload->>'model'), ''), 'claude-sonnet-5');
  v_root public.creative_runs%ROWTYPE;
  v_item JSONB;
  v_concept_id TEXT;
  v_child public.creative_runs%ROWTYPE;
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'job_id and root_creative_run_id are required';
  END IF;
  IF jsonb_typeof(v_moments) IS DISTINCT FROM 'array' OR jsonb_array_length(v_moments) = 0 THEN
    RAISE EXCEPTION 'moments must be a non-empty array';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'game discovery root creative run not found or job mismatch';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_moments)
  LOOP
    IF v_item->>'schema' IS DISTINCT FROM 'gameplay_moment'
       OR v_item->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'unsupported gameplay_moment schema/version';
    END IF;
    v_concept_id := NULLIF(trim(v_item->>'conceptId'), '');
    IF v_concept_id IS NULL THEN
      RAISE EXCEPTION 'gameplay moment is missing conceptId';
    END IF;

    SELECT * INTO v_child
    FROM public.creative_runs
    WHERE parent_run_id = v_root_run_id
      AND metadata->>'domain_kind' = 'coop_game_concept'
      AND metadata->>'concept_id' = v_concept_id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'concept run not found for %', v_concept_id;
    END IF;

    UPDATE public.creative_runs
    SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
      'gameplay_moment', v_item
    )
    WHERE id = v_child.id;
  END LOOP;

  UPDATE public.creative_runs
  SET
    outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
      'gameplay_moments', v_moments,
      'moment_planner_metadata', v_metadata || jsonb_build_object('model', v_model)
    ),
    usage = COALESCE(usage, '{}'::JSONB) || jsonb_build_object(
      'gameplay_moment_planner', COALESCE(v_metadata->'usage', '{}'::JSONB)
    )
  WHERE id = v_root_run_id;

  INSERT INTO public.factory_workflow_events (
    job_id, event_type, dedupe_key, payload, creative_run_id
  )
  VALUES (
    v_job_id,
    'discovery.gameplay_moments_persisted',
    'stage4:s4-004:gameplay-moments-persisted',
    jsonb_build_object(
      'moment_count', jsonb_array_length(v_moments),
      'model', v_model
    ),
    v_root_run_id
  )
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('moment_count', jsonb_array_length(v_moments));
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_gameplay_moments(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_gameplay_moments(JSONB)
  TO service_role;
