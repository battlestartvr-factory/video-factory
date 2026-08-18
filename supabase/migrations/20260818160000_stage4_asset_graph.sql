-- Stage 4 / S4-005c: deterministic AssetGraph persistence after approved gameplay videos complete.
-- This migration has no provider side effects. It only validates existing lineage and stores the graph.

CREATE OR REPLACE FUNCTION public.orchestrator_persist_gameplay_asset_graph(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_job_id UUID := NULLIF(payload->>'root_job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_concept_run_id UUID := NULLIF(payload->>'concept_run_id', '')::UUID;
  v_graph JSONB := COALESCE(payload->'asset_graph', '{}'::JSONB);
  v_root public.creative_runs%ROWTYPE;
  v_concept public.creative_runs%ROWTYPE;
  v_concept_id TEXT;
  v_shot_id TEXT;
  v_image_generation_id UUID;
  v_video_generation_id UUID;
  v_image public.generations%ROWTYPE;
  v_video public.generations%ROWTYPE;
  v_review public.gameplay_reference_reviews%ROWTYPE;
BEGIN
  IF v_root_job_id IS NULL OR v_root_run_id IS NULL OR v_concept_run_id IS NULL THEN
    RAISE EXCEPTION 'root_job_id, root_creative_run_id and concept_run_id are required';
  END IF;
  IF jsonb_typeof(v_graph) IS DISTINCT FROM 'object'
     OR v_graph->>'schema' IS DISTINCT FROM 'asset_graph'
     OR v_graph->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'asset_graph v1 object is required';
  END IF;
  IF v_graph->>'objectiveRunId' IS DISTINCT FROM v_root_run_id::TEXT
     OR v_graph->>'conceptRunId' IS DISTINCT FROM v_concept_run_id::TEXT THEN
    RAISE EXCEPTION 'asset graph root/concept lineage mismatch';
  END IF;
  IF jsonb_typeof(COALESCE(v_graph->'nodes', '[]'::JSONB)) IS DISTINCT FROM 'array'
     OR jsonb_typeof(COALESCE(v_graph->'edges', '[]'::JSONB)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'asset graph nodes and edges must be arrays';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_root_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root/job mismatch'; END IF;

  SELECT * INTO v_concept
  FROM public.creative_runs
  WHERE id = v_concept_run_id
    AND parent_run_id = v_root_run_id
    AND metadata->>'domain_kind' = 'coop_game_concept';
  IF NOT FOUND THEN RAISE EXCEPTION 'concept run is not a child of discovery root'; END IF;

  v_concept_id := NULLIF(v_concept.metadata->>'concept_id', '');
  v_shot_id := NULLIF(v_graph#>>'{metadata,shotId}', '');
  IF v_concept_id IS NULL OR v_shot_id IS NULL THEN
    RAISE EXCEPTION 'asset graph concept/shot metadata is required';
  END IF;
  IF v_graph#>>'{metadata,conceptId}' IS DISTINCT FROM v_concept_id THEN
    RAISE EXCEPTION 'asset graph concept id mismatch';
  END IF;
  IF v_concept.outputs->'gameplay_shot'->>'shotId' IS DISTINCT FROM v_shot_id THEN
    RAISE EXCEPTION 'asset graph is not aligned to the active gameplay shot';
  END IF;

  SELECT NULLIF(node->>'generationId', '')::UUID INTO v_image_generation_id
  FROM jsonb_array_elements(v_graph->'nodes') node
  WHERE node->>'kind' = 'image'
  LIMIT 1;
  SELECT NULLIF(node->>'generationId', '')::UUID INTO v_video_generation_id
  FROM jsonb_array_elements(v_graph->'nodes') node
  WHERE node->>'kind' = 'video'
  LIMIT 1;
  IF v_image_generation_id IS NULL OR v_video_generation_id IS NULL THEN
    RAISE EXCEPTION 'asset graph requires image and video generation nodes';
  END IF;
  IF (SELECT COUNT(*) FROM jsonb_array_elements(v_graph->'nodes') node WHERE node->>'kind' = 'image') <> 1
     OR (SELECT COUNT(*) FROM jsonb_array_elements(v_graph->'nodes') node WHERE node->>'kind' = 'video') <> 1 THEN
    RAISE EXCEPTION 'Stage 4 prototype asset graph requires exactly one image and one video node';
  END IF;

  SELECT g.* INTO v_image
  FROM public.generations g
  JOIN public.factory_jobs fj ON fj.id = g.factory_job_id
  WHERE g.id = v_image_generation_id
    AND g.type = 'image'
    AND g.status = 'completed'
    AND fj.parent_job_id = v_root_job_id
    AND COALESCE((g.settings->>'stage4_reference')::BOOLEAN, false) = true
    AND g.settings->>'root_creative_run_id' = v_root_run_id::TEXT
    AND g.settings->>'shot_id' = v_shot_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset graph image is not the completed active Stage 4 reference child'; END IF;

  SELECT r.* INTO v_review
  FROM public.gameplay_reference_reviews r
  WHERE r.root_creative_run_id = v_root_run_id
    AND r.generation_id = v_image_generation_id
  ORDER BY r.created_at DESC
  LIMIT 1;
  IF NOT FOUND OR v_review.decision IS DISTINCT FROM 'approve' THEN
    RAISE EXCEPTION 'asset graph reference image requires current human APPROVE';
  END IF;

  SELECT g.* INTO v_video
  FROM public.generations g
  JOIN public.factory_jobs fj ON fj.id = g.factory_job_id
  WHERE g.id = v_video_generation_id
    AND g.type = 'video'
    AND g.status = 'completed'
    AND fj.parent_job_id = v_root_job_id
    AND COALESCE((g.settings->>'stage4_gameplay_video')::BOOLEAN, false) = true
    AND g.settings->>'root_creative_run_id' = v_root_run_id::TEXT
    AND g.settings->>'shot_id' = v_shot_id
    AND g.settings->>'approved_reference_generation_id' = v_image_generation_id::TEXT;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset graph video is not the completed child of the approved reference'; END IF;

  IF v_graph#>>'{metadata,approvedReferenceGenerationId}' IS DISTINCT FROM v_image_generation_id::TEXT
     OR v_graph#>>'{metadata,videoGenerationId}' IS DISTINCT FROM v_video_generation_id::TEXT THEN
    RAISE EXCEPTION 'asset graph generation metadata mismatch';
  END IF;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object('asset_graph', v_graph)
  WHERE id = v_concept_run_id;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
    'asset_graphs',
    COALESCE(outputs->'asset_graphs', '{}'::JSONB) || jsonb_build_object(v_concept_id, v_graph)
  )
  WHERE id = v_root_run_id;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload, creative_run_id)
  VALUES (
    v_root_job_id,
    'discovery.asset_graph_persisted',
    'stage4:asset-graph:' || v_video_generation_id::TEXT,
    jsonb_build_object(
      'concept_run_id', v_concept_run_id,
      'concept_id', v_concept_id,
      'shot_id', v_shot_id,
      'reference_generation_id', v_image_generation_id,
      'video_generation_id', v_video_generation_id
    ),
    v_root_run_id
  )
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'persisted', true,
    'concept_run_id', v_concept_run_id,
    'concept_id', v_concept_id,
    'reference_generation_id', v_image_generation_id,
    'video_generation_id', v_video_generation_id,
    'asset_graph', v_graph
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_gameplay_asset_graph(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_gameplay_asset_graph(JSONB)
  TO service_role;
