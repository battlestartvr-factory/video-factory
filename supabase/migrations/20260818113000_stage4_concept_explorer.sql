-- Stage 4 / S4-003: Concept Explorer persistence + bounded history retrieval.
-- Keeps game-domain payloads in creative_runs JSONB and makes worker retries idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_runs_unique_concept_per_parent
  ON public.creative_runs (parent_run_id, ((metadata->>'concept_id')))
  WHERE parent_run_id IS NOT NULL
    AND metadata->>'domain_kind' = 'coop_game_concept';

CREATE OR REPLACE FUNCTION public.orchestrator_get_game_concept_history(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_limit INTEGER := LEAST(GREATEST(COALESCE((payload->>'limit')::INTEGER, 200), 1), 200);
  v_root public.creative_runs%ROWTYPE;
  v_result JSONB;
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

  SELECT COALESCE(jsonb_agg(item ORDER BY created_at DESC), '[]'::JSONB)
  INTO v_result
  FROM (
    SELECT
      cr.created_at,
      jsonb_build_object(
        'run_id', cr.id,
        'parent_run_id', cr.parent_run_id,
        'concept', cr.outputs->'coop_game_concept'
      ) AS item
    FROM public.creative_runs cr
    WHERE cr.id <> v_root_run_id
      AND cr.metadata->>'domain_kind' = 'coop_game_concept'
      AND cr.outputs ? 'coop_game_concept'
      AND (
        (v_root.project_id IS NOT NULL AND cr.project_id = v_root.project_id)
        OR
        (v_root.project_id IS NULL AND cr.project_id IS NULL AND cr.user_id = v_root.user_id)
      )
    ORDER BY cr.created_at DESC
    LIMIT v_limit
  ) history_rows;

  RETURN jsonb_build_object('items', v_result);
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_game_concept_history(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_game_concept_history(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_persist_game_concept_exploration(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_accepted JSONB := COALESCE(payload->'accepted_concepts', '[]'::JSONB);
  v_rejected JSONB := COALESCE(payload->'rejections', '[]'::JSONB);
  v_explorer JSONB := COALESCE(payload->'explorer_metadata', '{}'::JSONB);
  v_model TEXT := NULLIF(trim(payload->>'model'), '');
  v_job public.factory_jobs%ROWTYPE;
  v_root public.creative_runs%ROWTYPE;
  v_item JSONB;
  v_concept_id TEXT;
  v_child public.creative_runs%ROWTYPE;
  v_children JSONB := '[]'::JSONB;
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'job_id and root_creative_run_id are required';
  END IF;
  IF jsonb_typeof(v_accepted) IS DISTINCT FROM 'array' OR jsonb_array_length(v_accepted) = 0 THEN
    RAISE EXCEPTION 'accepted_concepts must be a non-empty array';
  END IF;
  IF jsonb_typeof(v_rejected) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'rejections must be an array';
  END IF;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE id = v_job_id
    AND workflow_kind = 'game_discovery_batch'
    AND workflow_version = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'game discovery factory job not found';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'game discovery root creative run not found or job mismatch';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_accepted)
  LOOP
    IF v_item->>'schema' IS DISTINCT FROM 'coop_game_concept'
       OR v_item->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'unsupported coop_game_concept schema/version';
    END IF;

    v_concept_id := NULLIF(trim(v_item->>'conceptId'), '');
    IF v_concept_id IS NULL THEN
      RAISE EXCEPTION 'accepted concept is missing conceptId';
    END IF;

    SELECT * INTO v_child
    FROM public.creative_runs
    WHERE parent_run_id = v_root_run_id
      AND metadata->>'domain_kind' = 'coop_game_concept'
      AND metadata->>'concept_id' = v_concept_id
    ORDER BY created_at ASC
    LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO public.creative_runs (
        user_id,
        project_id,
        parent_run_id,
        factory_job_id,
        run_type,
        status,
        title,
        objective,
        hypothesis,
        model,
        provider,
        inputs,
        outputs,
        metadata,
        completed_at
      )
      VALUES (
        v_root.user_id,
        v_root.project_id,
        v_root_run_id,
        v_job_id,
        'concept',
        'completed',
        NULLIF(v_item->>'oneSentencePitch', ''),
        v_root.objective,
        NULLIF(v_item->>'coopDependency', ''),
        COALESCE(v_model, 'claude-sonnet-5'),
        'kie',
        jsonb_build_object(
          'discovery_objective', v_root.inputs->'discovery_objective'
        ),
        jsonb_build_object(
          'coop_game_concept', v_item
        ),
        jsonb_build_object(
          'domain_kind', 'coop_game_concept',
          'domain_schema', 'coop_game_concept',
          'domain_version', 1,
          'concept_id', v_concept_id,
          'root_discovery_run_id', v_root_run_id,
          'source_stage', 's4_003_concept_explorer'
        ),
        NOW()
      )
      ON CONFLICT DO NOTHING
      RETURNING * INTO v_child;

      IF NOT FOUND THEN
        SELECT * INTO v_child
        FROM public.creative_runs
        WHERE parent_run_id = v_root_run_id
          AND metadata->>'domain_kind' = 'coop_game_concept'
          AND metadata->>'concept_id' = v_concept_id
        ORDER BY created_at ASC
        LIMIT 1;
      END IF;
    END IF;

    v_children := v_children || jsonb_build_array(
      jsonb_build_object(
        'run_id', v_child.id,
        'concept_id', v_concept_id
      )
    );
  END LOOP;

  UPDATE public.creative_runs
  SET
    status = 'running',
    model = COALESCE(v_model, model, 'claude-sonnet-5'),
    provider = COALESCE(provider, 'kie'),
    outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
      'discovery_concepts', v_accepted,
      'diversity_rejections', v_rejected,
      'concept_explorer', v_explorer,
      'concept_runs', v_children
    ),
    usage = COALESCE(usage, '{}'::JSONB) || jsonb_build_object(
      'concept_explorer', COALESCE(v_explorer->'usage', '{}'::JSONB)
    )
  WHERE id = v_root_run_id
  RETURNING * INTO v_root;

  INSERT INTO public.factory_workflow_events (
    job_id,
    event_type,
    dedupe_key,
    payload,
    creative_run_id
  )
  VALUES (
    v_job_id,
    'discovery.concepts_persisted',
    'stage4:s4-003:concepts-persisted',
    jsonb_build_object(
      'creative_run_id', v_root_run_id,
      'accepted_count', jsonb_array_length(v_accepted),
      'rejected_count', jsonb_array_length(v_rejected),
      'concept_runs', v_children,
      'model', COALESCE(v_model, 'claude-sonnet-5')
    ),
    v_root_run_id
  )
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'root_creative_run_id', v_root_run_id,
    'concept_runs', v_children,
    'accepted_count', jsonb_array_length(v_accepted),
    'rejected_count', jsonb_array_length(v_rejected)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_game_concept_exploration(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_game_concept_exploration(JSONB)
  TO service_role;
