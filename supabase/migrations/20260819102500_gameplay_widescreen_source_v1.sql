-- Gameplay source media must look like real desktop PC capture.
-- Reference images and Kling gameplay clips are generated in 16:9.
-- Vertical 9:16 is a downstream assembly/editing concern only.

CREATE OR REPLACE FUNCTION public.orchestrator_create_approved_gameplay_video(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_root_job_id UUID := NULLIF(payload->>'root_job_id','')::UUID; v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id','')::UUID; v_request_id UUID := NULLIF(payload->>'request_id','')::UUID; v_reference_generation_id UUID := NULLIF(payload->>'reference_generation_id','')::UUID; v_shot_id TEXT := NULLIF(trim(payload->>'shot_id'),'');
  v_root public.creative_runs%ROWTYPE; v_concept public.creative_runs%ROWTYPE; v_reference public.generations%ROWTYPE; v_review public.gameplay_reference_reviews%ROWTYPE; v_reference_url TEXT; v_video_prompt TEXT; v_video_model TEXT; v_concept_id TEXT; v_moment_id TEXT; v_result JSONB; v_video_generation_id UUID; v_child_job_id UUID; v_request_entry JSONB;
BEGIN
  IF v_root_job_id IS NULL OR v_root_run_id IS NULL OR v_request_id IS NULL OR v_reference_generation_id IS NULL OR v_shot_id IS NULL THEN RAISE EXCEPTION 'root_job_id, root_creative_run_id, request_id, reference_generation_id and shot_id are required'; END IF;
  SELECT * INTO v_root FROM public.creative_runs WHERE id=v_root_run_id AND factory_job_id=v_root_job_id AND metadata->>'domain_kind'='game_discovery_batch'; IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root/job mismatch'; END IF;
  SELECT g.* INTO v_reference FROM public.generations g JOIN public.factory_jobs fj ON fj.id=g.factory_job_id WHERE g.id=v_reference_generation_id AND g.type='image' AND g.status='completed' AND fj.parent_job_id=v_root_job_id AND COALESCE((g.settings->>'stage4_reference')::BOOLEAN,false)=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'approved video requires a completed Stage 4 reference child'; END IF;
  IF v_reference.settings->>'shot_id' IS DISTINCT FROM v_shot_id THEN RAISE EXCEPTION 'reference generation does not belong to shot %',v_shot_id; END IF;
  SELECT r.* INTO v_review FROM public.gameplay_reference_reviews r WHERE r.root_creative_run_id=v_root_run_id AND r.generation_id=v_reference_generation_id ORDER BY r.created_at DESC LIMIT 1;
  IF NOT FOUND OR v_review.decision IS DISTINCT FROM 'approve' THEN RAISE EXCEPTION 'human APPROVE review is required before video generation'; END IF;
  SELECT item->>'url' INTO v_reference_url FROM jsonb_array_elements(COALESCE(v_reference.outputs,'[]'::JSONB)) item WHERE NULLIF(item->>'url','') IS NOT NULL LIMIT 1; IF v_reference_url IS NULL THEN RAISE EXCEPTION 'approved reference has no usable output URL'; END IF;
  v_concept_id := NULLIF(v_reference.settings->>'concept_id',''); v_moment_id := NULLIF(v_reference.settings->>'moment_id','');
  SELECT * INTO v_concept FROM public.creative_runs WHERE parent_run_id=v_root_run_id AND metadata->>'domain_kind'='coop_game_concept' AND metadata->>'concept_id'=v_concept_id LIMIT 1; IF NOT FOUND THEN RAISE EXCEPTION 'concept run not found for approved reference'; END IF;
  IF v_concept.outputs->'gameplay_shot'->>'shotId' IS DISTINCT FROM v_shot_id THEN RAISE EXCEPTION 'approved reference is no longer aligned to the active shot'; END IF;
  IF v_concept.outputs->'prompt_plan'->>'shotId' IS DISTINCT FROM v_shot_id THEN RAISE EXCEPTION 'approved reference is no longer aligned to the active prompt plan'; END IF;
  v_video_prompt := NULLIF(v_concept.outputs#>>'{prompt_plan,videoPrompt}',''); v_video_model := COALESCE(NULLIF(v_concept.outputs#>>'{gameplay_shot,generationPlan,videoModel}',''),'kling-3'); IF v_video_prompt IS NULL THEN RAISE EXCEPTION 'video prompt is missing for approved shot'; END IF;
  SELECT public.orchestrator_create_video_generation(jsonb_build_object(
    'request_id',v_request_id,'user_id',v_root.user_id,'project_id',v_root.project_id,'prompt',v_video_prompt,'model_id',v_video_model,'mode','image-to-video',
    'settings',jsonb_build_object('aspectRatio','16:9','durationSec',5,'effectiveQuality','pro','sound',false,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9','root_creative_run_id',v_root_run_id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id),
    'reference_assets',jsonb_build_array(jsonb_build_object('id',v_reference_generation_id,'url',v_reference_url,'role','start_frame')),
    'action_input',jsonb_build_object('source','stage4_game_discovery_approved_reference','source_capture_format','desktop_pc_16x9','root_creative_run_id',v_root_run_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id)
  )) INTO v_result;
  v_video_generation_id := NULLIF(v_result#>>'{generation,id}','')::UUID; v_child_job_id := NULLIF(v_result->>'factory_job_id','')::UUID; IF v_video_generation_id IS NULL OR v_child_job_id IS NULL THEN RAISE EXCEPTION 'durable gameplay video admission returned no generation/job id'; END IF;
  UPDATE public.factory_jobs SET parent_job_id=v_root_job_id,
    input=COALESCE(input,'{}'::JSONB)||jsonb_build_object('parent_job_id',v_root_job_id,'root_creative_run_id',v_root_run_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9'),
    state=COALESCE(state,'{}'::JSONB)||jsonb_build_object('parent_job_id',v_root_job_id,'root_creative_run_id',v_root_run_id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9') WHERE id=v_child_job_id;
  v_request_entry := jsonb_build_object('request_id',v_request_id,'generation_id',v_video_generation_id,'factory_job_id',v_child_job_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'model_id',v_video_model,'aspect_ratio','16:9','effective_quality','pro','approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id,'created_at',NOW());
  UPDATE public.creative_runs SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object('gameplay_video_requests',COALESCE(outputs->'gameplay_video_requests','{}'::JSONB)||jsonb_build_object(v_shot_id,v_request_entry)) WHERE id=v_root_run_id;
  UPDATE public.creative_runs SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object('gameplay_video_request',v_request_entry) WHERE id=v_concept.id;
  INSERT INTO public.factory_workflow_events(job_id,event_type,dedupe_key,payload,creative_run_id) VALUES(v_root_job_id,'discovery.approved_video_admitted','stage4:approved-video:'||v_request_id::TEXT,v_request_entry,v_root_run_id) ON CONFLICT(dedupe_key) DO NOTHING;
  RETURN v_result||jsonb_build_object('root_job_id',v_root_job_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id);
END; $function$;

CREATE OR REPLACE FUNCTION public.orchestrator_create_gameplay_reference_image(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_root_job_id UUID := NULLIF(payload->>'root_job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_request_id UUID := NULLIF(payload->>'request_id', '')::UUID;
  v_concept_id TEXT := NULLIF(trim(payload->>'concept_id'), '');
  v_moment_id TEXT := NULLIF(trim(payload->>'moment_id'), '');
  v_shot_id TEXT := NULLIF(trim(payload->>'shot_id'), '');
  v_prompt TEXT := NULLIF(trim(payload->>'prompt'), '');
  v_model_id TEXT := COALESCE(NULLIF(trim(payload->>'model_id'), ''), 'nano-banana-2');
  v_settings JSONB := COALESCE(payload->'settings', '{}'::JSONB);
  v_reference_assets JSONB := COALESCE(payload->'reference_assets', '[]'::JSONB);
  v_reference_lineage JSONB := COALESCE(payload->'reference_lineage', '[]'::JSONB);
  v_root public.creative_runs%ROWTYPE;
  v_concept public.creative_runs%ROWTYPE;
  v_generation_result JSONB;
  v_generation_id UUID;
  v_child_job_id UUID;
  v_request_entry JSONB;
  v_mode TEXT;
BEGIN
  IF v_root_job_id IS NULL OR v_root_run_id IS NULL OR v_request_id IS NULL OR
     v_concept_id IS NULL OR v_moment_id IS NULL OR v_shot_id IS NULL OR v_prompt IS NULL THEN
    RAISE EXCEPTION 'root_job_id, root_creative_run_id, request_id, concept_id, moment_id, shot_id and prompt are required';
  END IF;
  IF jsonb_typeof(v_reference_assets) <> 'array' OR jsonb_typeof(v_reference_lineage) <> 'array' THEN
    RAISE EXCEPTION 'reference_assets and reference_lineage must be arrays';
  END IF;
  IF jsonb_array_length(v_reference_assets) > 8 OR jsonb_array_length(v_reference_lineage) > 8 THEN
    RAISE EXCEPTION 'at most 8 gameplay references are allowed';
  END IF;
  IF jsonb_array_length(v_reference_assets) <> jsonb_array_length(v_reference_lineage) THEN
    RAISE EXCEPTION 'reference_assets and reference_lineage counts must match';
  END IF;

  SELECT * INTO v_root FROM public.creative_runs
  WHERE id = v_root_run_id AND factory_job_id = v_root_job_id AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root/job mismatch'; END IF;

  SELECT * INTO v_concept FROM public.creative_runs
  WHERE parent_run_id = v_root_run_id AND metadata->>'domain_kind' = 'coop_game_concept' AND metadata->>'concept_id' = v_concept_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'concept run not found for %', v_concept_id; END IF;
  IF v_concept.outputs->'gameplay_shot'->>'shotId' IS DISTINCT FROM v_shot_id THEN RAISE EXCEPTION 'shot % is not the active planned shot for concept %', v_shot_id, v_concept_id; END IF;
  IF v_concept.outputs->'prompt_plan'->>'shotId' IS DISTINCT FROM v_shot_id THEN RAISE EXCEPTION 'prompt plan is not aligned to shot %', v_shot_id; END IF;

  v_mode := CASE WHEN jsonb_array_length(v_reference_assets) > 0 THEN 'image-to-image' ELSE 'text-to-image' END;

  SELECT public.orchestrator_create_image_generation(jsonb_build_object(
      'request_id', v_request_id, 'user_id', v_root.user_id, 'project_id', v_root.project_id, 'prompt', v_prompt,
      'model_id', v_model_id, 'mode', v_mode,
      'settings', v_settings || jsonb_build_object('aspectRatio','16:9','effectiveQuality','1K','source_capture_format','desktop_pc_16x9','stage4_reference',true,'root_creative_run_id',v_root_run_id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'gameplay_reference_lineage',v_reference_lineage),
      'reference_assets', v_reference_assets,
      'action_input', jsonb_build_object('source','stage4_game_discovery_reference','source_capture_format','desktop_pc_16x9','root_creative_run_id',v_root_run_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'video_generation_locked',true,'gameplay_reference_lineage',v_reference_lineage)
  )) INTO v_generation_result;

  v_generation_id := NULLIF(v_generation_result#>>'{generation,id}', '')::UUID;
  v_child_job_id := NULLIF(v_generation_result->>'factory_job_id', '')::UUID;
  IF v_generation_id IS NULL OR v_child_job_id IS NULL THEN RAISE EXCEPTION 'durable reference image admission returned no generation/job id'; END IF;

  UPDATE public.factory_jobs SET parent_job_id=v_root_job_id,
      input=COALESCE(input,'{}'::JSONB)||jsonb_build_object('parent_job_id',v_root_job_id,'root_creative_run_id',v_root_run_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'stage4_reference',true,'source_capture_format','desktop_pc_16x9','gameplay_reference_lineage',v_reference_lineage),
      state=COALESCE(state,'{}'::JSONB)||jsonb_build_object('parent_job_id',v_root_job_id,'root_creative_run_id',v_root_run_id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'stage4_reference',true,'source_capture_format','desktop_pc_16x9','gameplay_reference_lineage',v_reference_lineage)
  WHERE id=v_child_job_id;

  v_request_entry := jsonb_build_object('request_id',v_request_id,'generation_id',v_generation_id,'factory_job_id',v_child_job_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'model_id',v_model_id,'aspect_ratio','16:9',
    'gameplay_reference_ids',(SELECT COALESCE(jsonb_agg(item->>'referenceId'), '[]'::JSONB) FROM jsonb_array_elements(v_reference_lineage) item),
    'gameplay_reference_lineage',v_reference_lineage,'created_at',NOW());

  UPDATE public.creative_runs SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object('reference_image_requests',COALESCE(outputs->'reference_image_requests','{}'::JSONB)||jsonb_build_object(v_shot_id,v_request_entry)) WHERE id=v_root_run_id;
  UPDATE public.creative_runs SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object('reference_image_request',v_request_entry) WHERE id=v_concept.id;
  INSERT INTO public.factory_workflow_events(job_id,event_type,dedupe_key,payload,creative_run_id)
  VALUES(v_root_job_id,'discovery.reference_image_admitted','stage4:reference-image:'||v_request_id::TEXT,v_request_entry||jsonb_build_object('video_generation_locked',true),v_root_run_id)
  ON CONFLICT(dedupe_key) DO NOTHING;

  RETURN v_generation_result || jsonb_build_object('root_job_id',v_root_job_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'gameplay_reference_lineage',v_reference_lineage);
END;
$function$;
