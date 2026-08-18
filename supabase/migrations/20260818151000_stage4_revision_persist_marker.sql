-- Stage 4: stamp the currently prepared reference revision into the same transaction that
-- persists revised ShotSpec/PromptPlan output. A retry can then skip the LLM replan safely.

CREATE OR REPLACE FUNCTION public.orchestrator_persist_gameplay_shots_and_prompts(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_shots JSONB := COALESCE(payload->'shots', '[]'::JSONB);
  v_prompts JSONB := COALESCE(payload->'prompt_plans', '[]'::JSONB);
  v_shot_metadata JSONB := COALESCE(payload->'shot_planner_metadata', '{}'::JSONB);
  v_prompt_metadata JSONB := COALESCE(payload->'prompt_compiler_metadata', '{}'::JSONB);
  v_root public.creative_runs%ROWTYPE;
  v_item JSONB;
  v_moment_id TEXT;
  v_concept_id TEXT;
  v_child public.creative_runs%ROWTYPE;
  v_revision_key TEXT;
  v_revision_number INTEGER;
  v_event_key TEXT;
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL THEN RAISE EXCEPTION 'job_id and root_creative_run_id are required'; END IF;
  IF jsonb_typeof(v_shots) IS DISTINCT FROM 'array' OR jsonb_array_length(v_shots) = 0 THEN RAISE EXCEPTION 'shots must be a non-empty array'; END IF;
  IF jsonb_typeof(v_prompts) IS DISTINCT FROM 'array' OR jsonb_array_length(v_prompts) <> jsonb_array_length(v_shots) THEN RAISE EXCEPTION 'prompt_plans must match shot count'; END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found or job mismatch'; END IF;

  v_revision_key := NULLIF(v_root.outputs->>'last_reference_revision_key', '');
  v_revision_number := COALESCE((v_root.outputs->>'reference_revision_number')::INTEGER, 0);
  IF v_revision_key IS NOT NULL THEN
    v_shot_metadata := v_shot_metadata || jsonb_build_object(
      'reference_revision_key', v_revision_key,
      'reference_revision_number', v_revision_number
    );
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_shots)
  LOOP
    IF v_item->>'schema' IS DISTINCT FROM 'gameplay_shot' OR v_item->>'version' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'unsupported gameplay_shot schema/version'; END IF;
    v_moment_id := NULLIF(trim(v_item->>'momentId'), '');
    IF v_moment_id IS NULL THEN RAISE EXCEPTION 'shot is missing momentId'; END IF;
    SELECT cr.metadata->>'concept_id' INTO v_concept_id
    FROM public.creative_runs cr
    WHERE cr.parent_run_id = v_root_run_id
      AND cr.metadata->>'domain_kind' = 'coop_game_concept'
      AND cr.outputs->'gameplay_moment'->>'momentId' = v_moment_id
    LIMIT 1;
    IF v_concept_id IS NULL THEN RAISE EXCEPTION 'concept not found for moment %', v_moment_id; END IF;
    SELECT * INTO v_child
    FROM public.creative_runs
    WHERE parent_run_id = v_root_run_id
      AND metadata->>'domain_kind' = 'coop_game_concept'
      AND metadata->>'concept_id' = v_concept_id
    LIMIT 1;
    UPDATE public.creative_runs
    SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object('gameplay_shot', v_item)
    WHERE id = v_child.id;
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_prompts)
  LOOP
    IF v_item->>'schema' IS DISTINCT FROM 'prompt_plan' OR v_item->>'version' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'unsupported prompt_plan schema/version'; END IF;
    v_concept_id := NULLIF(trim(v_item->>'conceptId'), '');
    IF v_concept_id IS NULL THEN RAISE EXCEPTION 'prompt plan is missing conceptId'; END IF;
    UPDATE public.creative_runs
    SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object('prompt_plan', v_item)
    WHERE parent_run_id = v_root_run_id
      AND metadata->>'domain_kind' = 'coop_game_concept'
      AND metadata->>'concept_id' = v_concept_id;
  END LOOP;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
      'gameplay_shots', v_shots,
      'prompt_plans', v_prompts,
      'shot_planner_metadata', v_shot_metadata,
      'prompt_compiler_metadata', v_prompt_metadata,
      'reference_approval_required', true
    ),
    usage = COALESCE(usage, '{}'::JSONB) || jsonb_build_object(
      'shot_planner', COALESCE(v_shot_metadata->'usage', '{}'::JSONB)
    )
  WHERE id = v_root_run_id;

  v_event_key := CASE
    WHEN v_revision_key IS NULL THEN 'stage4:s4-004:shots-prompts-persisted'
    ELSE 'stage4:s4-004:shots-prompts-persisted:revision:' || v_revision_key
  END;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload, creative_run_id)
  VALUES (
    v_job_id,
    'discovery.shots_prompts_persisted',
    v_event_key,
    jsonb_build_object(
      'shot_count', jsonb_array_length(v_shots),
      'prompt_count', jsonb_array_length(v_prompts),
      'reference_approval_required', true,
      'reference_revision_key', v_revision_key,
      'reference_revision_number', v_revision_number
    ),
    v_root_run_id
  )
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'shot_count', jsonb_array_length(v_shots),
    'prompt_count', jsonb_array_length(v_prompts),
    'reference_approval_required', true,
    'reference_revision_key', v_revision_key,
    'reference_revision_number', v_revision_number
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_gameplay_shots_and_prompts(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_gameplay_shots_and_prompts(JSONB)
  TO service_role;
