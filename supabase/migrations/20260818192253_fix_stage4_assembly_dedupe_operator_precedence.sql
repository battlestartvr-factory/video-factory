CREATE OR REPLACE FUNCTION public.orchestrator_persist_gameplay_assembly(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_root_job_id UUID := NULLIF(payload->>'root_job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_concept_run_id UUID := NULLIF(payload->>'concept_run_id', '')::UUID;
  v_assembly JSONB := COALESCE(payload->'assembly', '{}'::JSONB);
  v_graph JSONB := COALESCE(payload->'asset_graph', '{}'::JSONB);
  v_root public.creative_runs%ROWTYPE;
  v_concept public.creative_runs%ROWTYPE;
  v_video public.generations%ROWTYPE;
  v_review public.gameplay_reference_reviews%ROWTYPE;
  v_concept_id TEXT;
  v_video_generation_id UUID;
  v_reference_generation_id UUID;
  v_short_drive_id TEXT;
  v_video_node_id TEXT;
  v_short_node_id TEXT;
BEGIN
  IF v_root_job_id IS NULL OR v_root_run_id IS NULL OR v_concept_run_id IS NULL THEN
    RAISE EXCEPTION 'root_job_id, root_creative_run_id and concept_run_id are required';
  END IF;
  IF v_assembly->>'schema' IS DISTINCT FROM 'gameplay_short_assembly'
     OR v_assembly->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'gameplay_short_assembly v1 object is required';
  END IF;
  IF v_graph->>'schema' IS DISTINCT FROM 'asset_graph'
     OR v_graph->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'asset_graph v1 object is required';
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
  IF v_concept_id IS NULL THEN RAISE EXCEPTION 'concept id is missing'; END IF;
  IF v_assembly->>'rootCreativeRunId' IS DISTINCT FROM v_root_run_id::TEXT
     OR v_assembly->>'conceptRunId' IS DISTINCT FROM v_concept_run_id::TEXT
     OR v_assembly->>'conceptId' IS DISTINCT FROM v_concept_id THEN
    RAISE EXCEPTION 'assembly root/concept lineage mismatch';
  END IF;
  IF v_graph->>'objectiveRunId' IS DISTINCT FROM v_root_run_id::TEXT
     OR v_graph->>'conceptRunId' IS DISTINCT FROM v_concept_run_id::TEXT
     OR v_graph#>>'{metadata,conceptId}' IS DISTINCT FROM v_concept_id THEN
    RAISE EXCEPTION 'assembled asset graph lineage mismatch';
  END IF;

  IF jsonb_typeof(v_assembly->'inputVideoGenerationIds') IS DISTINCT FROM 'array'
     OR jsonb_array_length(v_assembly->'inputVideoGenerationIds') <> 1 THEN
    RAISE EXCEPTION 'Stage 4 v1 assembly requires exactly one gameplay video input';
  END IF;
  v_video_generation_id := NULLIF(v_assembly#>>'{inputVideoGenerationIds,0}', '')::UUID;
  IF v_video_generation_id IS NULL THEN RAISE EXCEPTION 'assembly video generation id is required'; END IF;

  IF v_assembly->>'mimeType' IS DISTINCT FROM 'video/mp4'
     OR NULLIF(v_assembly->>'driveFileId', '') IS NULL
     OR COALESCE((v_assembly->>'sizeBytes')::BIGINT, 0) <= 0
     OR COALESCE((v_assembly->>'durationSeconds')::NUMERIC, 0) <= 0
     OR COALESCE((v_assembly->>'durationSeconds')::NUMERIC, 0) > 30
     OR COALESCE((v_assembly->>'width')::INT, 0) <> 1080
     OR COALESCE((v_assembly->>'height')::INT, 0) <> 1920
     OR ABS(COALESCE((v_assembly->>'fps')::NUMERIC, 0) - 30) > 0.1
     OR COALESCE((v_assembly->>'audioIncluded')::BOOLEAN, true) IS DISTINCT FROM false
     OR COALESCE(v_assembly->>'sha256', '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'assembly artifact violates the Stage 4 technical contract';
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
    AND g.settings->>'concept_id' = v_concept_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'assembly input is not a completed Stage 4 gameplay video child'; END IF;

  v_reference_generation_id := NULLIF(v_video.settings->>'approved_reference_generation_id', '')::UUID;
  IF v_reference_generation_id IS NULL THEN RAISE EXCEPTION 'gameplay video has no approved reference lineage'; END IF;
  SELECT r.* INTO v_review
  FROM public.gameplay_reference_reviews r
  WHERE r.root_creative_run_id = v_root_run_id
    AND r.generation_id = v_reference_generation_id
  ORDER BY r.created_at DESC
  LIMIT 1;
  IF NOT FOUND OR v_review.decision IS DISTINCT FROM 'approve' THEN
    RAISE EXCEPTION 'assembly video reference no longer has current human APPROVE';
  END IF;
  IF v_concept.outputs->'gameplay_shot'->>'shotId' IS DISTINCT FROM v_video.settings->>'shot_id' THEN
    RAISE EXCEPTION 'assembly video is no longer aligned to the active shot';
  END IF;

  SELECT node->>'id' INTO v_video_node_id
  FROM jsonb_array_elements(COALESCE(v_graph->'nodes', '[]'::JSONB)) node
  WHERE node->>'kind' = 'video'
    AND node->>'generationId' = v_video_generation_id::TEXT
  LIMIT 1;
  SELECT node->>'id', node->>'driveFileId' INTO v_short_node_id, v_short_drive_id
  FROM jsonb_array_elements(COALESCE(v_graph->'nodes', '[]'::JSONB)) node
  WHERE node->>'kind' = 'short'
  LIMIT 1;
  IF v_video_node_id IS NULL OR v_short_node_id IS NULL
     OR v_short_drive_id IS DISTINCT FROM v_assembly->>'driveFileId' THEN
    RAISE EXCEPTION 'assembled AssetGraph is missing the exact gameplay video or short Drive node';
  END IF;
  IF (SELECT COUNT(*) FROM jsonb_array_elements(v_graph->'nodes') node WHERE node->>'kind' = 'short') <> 1 THEN
    RAISE EXCEPTION 'Stage 4 v1 assembled AssetGraph requires exactly one short node';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_graph->'edges', '[]'::JSONB)) edge
    WHERE edge->>'from' = v_video_node_id
      AND edge->>'to' = v_short_node_id
      AND edge->>'relation' = 'assembles_into'
  ) THEN
    RAISE EXCEPTION 'assembled AssetGraph requires gameplay video -> short assembles_into lineage';
  END IF;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
        'prototype_assembly', v_assembly,
        'asset_graph', v_graph
      )
  WHERE id = v_concept_run_id;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
        'prototype_assemblies',
        COALESCE(outputs->'prototype_assemblies', '{}'::JSONB) || jsonb_build_object(v_concept_id, v_assembly),
        'asset_graphs',
        COALESCE(outputs->'asset_graphs', '{}'::JSONB) || jsonb_build_object(v_concept_id, v_graph)
      )
  WHERE id = v_root_run_id;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload, creative_run_id)
  VALUES (
    v_root_job_id,
    'discovery.prototype_assembled',
    format('stage4:prototype-assembly:%s:%s', v_concept_run_id::TEXT, v_assembly->>'sha256'),
    jsonb_build_object(
      'concept_run_id', v_concept_run_id,
      'concept_id', v_concept_id,
      'video_generation_id', v_video_generation_id,
      'drive_file_id', v_assembly->>'driveFileId',
      'sha256', v_assembly->>'sha256'
    ),
    v_root_run_id
  )
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'persisted', true,
    'concept_run_id', v_concept_run_id,
    'concept_id', v_concept_id,
    'assembly', v_assembly,
    'asset_graph', v_graph
  );
END;
$function$;
