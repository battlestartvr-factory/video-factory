CREATE OR REPLACE FUNCTION public.orchestrator_finalize_gameplay_discovery_batch(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_root_job_id UUID := NULLIF(payload->>'root_job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_root public.creative_runs%ROWTYPE;
  v_expected_count INT;
  v_assembly_count INT;
  v_missing INT;
  v_result JSONB;
BEGIN
  IF v_root_job_id IS NULL OR v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'root_job_id and root_creative_run_id are required';
  END IF;
  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_root_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root/job mismatch'; END IF;

  SELECT COUNT(*)::INT INTO v_expected_count
  FROM jsonb_each(COALESCE(v_root.outputs->'gameplay_video_requests', '{}'::JSONB)) req
  JOIN public.generations g ON g.id = NULLIF(req.value->>'generation_id', '')::UUID
  JOIN LATERAL (
    SELECT r.decision
    FROM public.gameplay_video_reviews r
    WHERE r.root_creative_run_id = v_root_run_id
      AND r.generation_id = g.id
    ORDER BY r.created_at DESC
    LIMIT 1
  ) review ON TRUE
  WHERE g.status = 'completed'
    AND review.decision = 'approve';

  SELECT COUNT(*)::INT INTO v_assembly_count
  FROM jsonb_object_keys(COALESCE(v_root.outputs->'prototype_assemblies', '{}'::JSONB));

  IF v_expected_count <= 0 OR v_assembly_count <> v_expected_count THEN
    RAISE EXCEPTION 'prototype assemblies are incomplete for human-approved videos: expected %, found %', v_expected_count, v_assembly_count;
  END IF;

  SELECT COUNT(*) INTO v_missing
  FROM jsonb_each(COALESCE(v_root.outputs->'gameplay_video_requests', '{}'::JSONB)) req
  JOIN public.generations g ON g.id = NULLIF(req.value->>'generation_id', '')::UUID
  JOIN LATERAL (
    SELECT r.decision
    FROM public.gameplay_video_reviews r
    WHERE r.root_creative_run_id = v_root_run_id
      AND r.generation_id = g.id
    ORDER BY r.created_at DESC
    LIMIT 1
  ) review ON TRUE
  WHERE g.status = 'completed'
    AND review.decision = 'approve'
    AND NOT EXISTS (
      SELECT 1
      FROM public.creative_runs concept
      WHERE concept.id = NULLIF(req.value->>'concept_run_id', '')::UUID
        AND concept.parent_run_id = v_root_run_id
        AND concept.metadata->>'domain_kind' = 'coop_game_concept'
        AND concept.outputs#>>'{prototype_assembly,conceptRunId}' = concept.id::TEXT
        AND concept.outputs#>'{prototype_assembly,inputVideoGenerationIds}' @> jsonb_build_array(req.value->>'generation_id')
        AND NULLIF(concept.outputs#>>'{prototype_assembly,driveFileId}', '') IS NOT NULL
    );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'prototype finalization found % human-approved video branches without a matching assembly', v_missing;
  END IF;

  v_result := jsonb_build_object(
    'schema', 'game_discovery_prototype_result',
    'version', 1,
    'prototypeCount', v_assembly_count,
    'assemblies', COALESCE(v_root.outputs->'prototype_assemblies', '{}'::JSONB),
    'humanApprovedVideoCount', v_expected_count,
    'completedAt', NOW()
  );

  UPDATE public.creative_runs
  SET status = 'completed',
      completed_at = COALESCE(completed_at, NOW()),
      outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object('prototype_result', v_result)
  WHERE id = v_root_run_id;

  UPDATE public.creative_runs
  SET status = 'completed',
      completed_at = COALESCE(completed_at, NOW())
  WHERE parent_run_id = v_root_run_id
    AND metadata->>'domain_kind' = 'coop_game_concept'
    AND outputs ? 'prototype_assembly';

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload, creative_run_id)
  VALUES (
    v_root_job_id,
    'discovery.prototype_batch_completed',
    'stage4:prototype-batch-completed:' || v_root_run_id::TEXT,
    v_result,
    v_root_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('completed', true, 'result', v_result);
END;
$function$;
