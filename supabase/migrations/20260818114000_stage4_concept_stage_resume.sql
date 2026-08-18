-- Stage 4 / S4-003: allow a restarted worker to detect a concept stage that was
-- already durably persisted before the parent workflow tick was committed.

CREATE OR REPLACE FUNCTION public.orchestrator_get_game_discovery_concept_stage(payload JSONB)
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
    'persisted',
      jsonb_typeof(v_root.outputs->'discovery_concepts') = 'array'
      AND jsonb_array_length(COALESCE(v_root.outputs->'discovery_concepts', '[]'::JSONB)) > 0,
    'accepted_concepts', COALESCE(v_root.outputs->'discovery_concepts', '[]'::JSONB),
    'concept_runs', COALESCE(v_root.outputs->'concept_runs', '[]'::JSONB),
    'concept_explorer', COALESCE(v_root.outputs->'concept_explorer', '{}'::JSONB),
    'diversity_rejections', COALESCE(v_root.outputs->'diversity_rejections', '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_game_discovery_concept_stage(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_game_discovery_concept_stage(JSONB)
  TO service_role;
