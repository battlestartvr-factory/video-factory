-- Stage 4 / S4-004+005 boundary: evidence-first shots, deterministic prompts and human reference approval memory.
-- No paid generation is admitted by this migration. The workflow can persist plans and park safely before reference images.

CREATE TABLE IF NOT EXISTS public.gameplay_reference_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_creative_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  concept_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  generation_id UUID REFERENCES public.generations(id) ON DELETE SET NULL,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  concept_id TEXT NOT NULL,
  moment_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'revise')),
  raw_feedback TEXT,
  structured_feedback JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_tags JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(error_tags) = 'array'),
  must_show JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(must_show) = 'array'),
  must_avoid JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(must_avoid) = 'array'),
  reusable_scope TEXT NOT NULL DEFAULT 'concept' CHECK (reusable_scope IN ('shot', 'concept', 'project')),
  model TEXT,
  usage JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gameplay_reference_reviews_root_created
  ON public.gameplay_reference_reviews (root_creative_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gameplay_reference_reviews_concept_created
  ON public.gameplay_reference_reviews (concept_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gameplay_reference_reviews_generation_user
  ON public.gameplay_reference_reviews (generation_id, user_id)
  WHERE generation_id IS NOT NULL AND user_id IS NOT NULL;

ALTER TABLE public.gameplay_reference_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gameplay_reference_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.gameplay_reference_reviews TO service_role;

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
    'gameplay_shots', COALESCE(v_root.outputs->'gameplay_shots', '[]'::JSONB),
    'prompt_plans', COALESCE(v_root.outputs->'prompt_plans', '[]'::JSONB),
    'shot_planner_metadata', COALESCE(v_root.outputs->'shot_planner_metadata', '{}'::JSONB),
    'prompt_compiler_metadata', COALESCE(v_root.outputs->'prompt_compiler_metadata', '{}'::JSONB),
    'reference_approval_required', COALESCE((v_root.outputs->>'reference_approval_required')::BOOLEAN, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_game_discovery_visual_stage(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_game_discovery_visual_stage(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_get_game_discovery_feedback_memory(payload JSONB)
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

  SELECT COALESCE(jsonb_agg(item ORDER BY created_at ASC), '[]'::JSONB)
  INTO v_items
  FROM (
    SELECT r.created_at,
      jsonb_build_object(
        'id', r.id,
        'concept_id', r.concept_id,
        'moment_id', r.moment_id,
        'shot_id', r.shot_id,
        'decision', r.decision,
        'structured_feedback', r.structured_feedback,
        'error_tags', r.error_tags,
        'must_show', r.must_show,
        'must_avoid', r.must_avoid,
        'reusable_scope', r.reusable_scope
      ) AS item
    FROM public.gameplay_reference_reviews r
    JOIN public.creative_runs review_root ON review_root.id = r.root_creative_run_id
    WHERE r.root_creative_run_id = v_root_run_id
       OR (
         r.reusable_scope = 'project'
         AND v_root.project_id IS NOT NULL
         AND review_root.project_id = v_root.project_id
       )
    ORDER BY r.created_at DESC
    LIMIT 100
  ) rows;

  RETURN jsonb_build_object('items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_game_discovery_feedback_memory(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_game_discovery_feedback_memory(JSONB)
  TO service_role;

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
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'job_id and root_creative_run_id are required';
  END IF;
  IF jsonb_typeof(v_shots) IS DISTINCT FROM 'array' OR jsonb_array_length(v_shots) = 0 THEN
    RAISE EXCEPTION 'shots must be a non-empty array';
  END IF;
  IF jsonb_typeof(v_prompts) IS DISTINCT FROM 'array' OR jsonb_array_length(v_prompts) <> jsonb_array_length(v_shots) THEN
    RAISE EXCEPTION 'prompt_plans must match shot count';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'game discovery root creative run not found or job mismatch';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_shots)
  LOOP
    IF v_item->>'schema' IS DISTINCT FROM 'gameplay_shot'
       OR v_item->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'unsupported gameplay_shot schema/version';
    END IF;
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
    IF v_item->>'schema' IS DISTINCT FROM 'prompt_plan'
       OR v_item->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'unsupported prompt_plan schema/version';
    END IF;
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

  INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload, creative_run_id)
  VALUES (
    v_job_id,
    'discovery.shots_prompts_persisted',
    'stage4:s4-004:shots-prompts-persisted',
    jsonb_build_object(
      'shot_count', jsonb_array_length(v_shots),
      'prompt_count', jsonb_array_length(v_prompts),
      'reference_approval_required', true
    ),
    v_root_run_id
  )
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'shot_count', jsonb_array_length(v_shots),
    'prompt_count', jsonb_array_length(v_prompts),
    'reference_approval_required', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_gameplay_shots_and_prompts(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_gameplay_shots_and_prompts(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_record_gameplay_reference_review(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_concept_run_id UUID := NULLIF(payload->>'concept_run_id', '')::UUID;
  v_generation_id UUID := NULLIF(payload->>'generation_id', '')::UUID;
  v_user_id UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_decision TEXT := NULLIF(trim(payload->>'decision'), '');
  v_structured JSONB := COALESCE(payload->'structured_feedback', '{}'::JSONB);
  v_review public.gameplay_reference_reviews%ROWTYPE;
BEGIN
  IF v_root_run_id IS NULL OR v_concept_run_id IS NULL OR v_decision IS NULL THEN
    RAISE EXCEPTION 'root_creative_run_id, concept_run_id and decision are required';
  END IF;
  IF v_decision NOT IN ('approve', 'reject', 'revise') THEN RAISE EXCEPTION 'invalid decision'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.creative_runs cr
    WHERE cr.id = v_concept_run_id AND cr.parent_run_id = v_root_run_id
      AND cr.metadata->>'domain_kind' = 'coop_game_concept'
  ) THEN RAISE EXCEPTION 'concept run is not a child of discovery root'; END IF;

  INSERT INTO public.gameplay_reference_reviews (
    root_creative_run_id, concept_run_id, generation_id, user_id,
    concept_id, moment_id, shot_id, decision, raw_feedback,
    structured_feedback, error_tags, must_show, must_avoid, reusable_scope, model, usage
  )
  VALUES (
    v_root_run_id, v_concept_run_id, v_generation_id, v_user_id,
    NULLIF(trim(payload->>'concept_id'), ''), NULLIF(trim(payload->>'moment_id'), ''),
    NULLIF(trim(payload->>'shot_id'), ''), v_decision, NULLIF(payload->>'raw_feedback', ''),
    v_structured, COALESCE(v_structured->'errorTags', '[]'::JSONB),
    COALESCE(v_structured->'mustShow', '[]'::JSONB), COALESCE(v_structured->'mustAvoid', '[]'::JSONB),
    COALESCE(NULLIF(v_structured->>'reusableScope', ''), 'concept'),
    NULLIF(trim(payload->>'model'), ''), COALESCE(payload->'usage', '{}'::JSONB)
  )
  RETURNING * INTO v_review;

  RETURN jsonb_build_object('review', to_jsonb(v_review));
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_gameplay_reference_review(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_gameplay_reference_review(JSONB)
  TO service_role;
