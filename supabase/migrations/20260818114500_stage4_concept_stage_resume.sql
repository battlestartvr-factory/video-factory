-- Stage 4 / S4-003 follow-up: restart-safe Concept Explorer stage reconciliation.
-- Service-role only. Lets the worker detect a committed concept batch after a transport/restart failure.

CREATE OR REPLACE FUNCTION public.orchestrator_get_game_discovery_concept_stage(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_root public.creative_runs%ROWTYPE;
  v_concept_runs JSONB;
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

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'run_id', cr.id,
        'concept_id', cr.metadata->>'concept_id'
      )
      ORDER BY cr.created_at ASC
    ),
    '[]'::JSONB
  )
  INTO v_concept_runs
  FROM public.creative_runs cr
  WHERE cr.parent_run_id = v_root_run_id
    AND cr.metadata->>'domain_kind' = 'coop_game_concept';

  RETURN jsonb_build_object(
    'persisted', jsonb_typeof(v_root.outputs->'discovery_concepts') = 'array'
      AND jsonb_array_length(v_root.outputs->'discovery_concepts') > 0,
    'accepted_concepts', COALESCE(v_root.outputs->'discovery_concepts', '[]'::JSONB),
    'diversity_rejections', COALESCE(v_root.outputs->'diversity_rejections', '[]'::JSONB),
    'concept_explorer', COALESCE(v_root.outputs->'concept_explorer', '{}'::JSONB),
    'concept_runs', v_concept_runs
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_game_discovery_concept_stage(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_game_discovery_concept_stage(JSONB)
  TO service_role;
