-- Stage 4 gameplay duration is planned once and must survive unchanged through
-- ShotSpec -> PromptPlan -> Kling admission. Kling 3 supports exactly 5/10/15 seconds.
CREATE OR REPLACE FUNCTION public.orchestrator_create_approved_gameplay_video(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_root_job_id UUID := NULLIF(payload->>'root_job_id','')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id','')::UUID;
  v_request_id UUID := NULLIF(payload->>'request_id','')::UUID;
  v_reference_generation_id UUID := NULLIF(payload->>'reference_generation_id','')::UUID;
  v_shot_id TEXT := NULLIF(trim(payload->>'shot_id'),'');
  v_video_prompt_override TEXT := NULLIF(trim(payload->>'video_prompt_override'),'');
  v_source_video_generation_id UUID := NULLIF(payload->>'source_video_generation_id','')::UUID;
  v_revision_review_id UUID := NULLIF(payload->>'revision_review_id','')::UUID;
  v_video_revision_number INTEGER := COALESCE(NULLIF(payload->>'video_revision_number','')::INTEGER,0);
  v_root public.creative_runs%ROWTYPE;
  v_concept public.creative_runs%ROWTYPE;
  v_reference public.generations%ROWTYPE;
  v_review public.gameplay_reference_reviews%ROWTYPE;
  v_reference_url TEXT;
  v_video_prompt TEXT;
  v_video_model TEXT;
  v_duration_sec INTEGER;
  v_concept_id TEXT;
  v_moment_id TEXT;
  v_result JSONB;
  v_video_generation_id UUID;
  v_child_job_id UUID;
  v_request_entry JSONB;
BEGIN
  IF v_root_job_id IS NULL OR v_root_run_id IS NULL OR v_request_id IS NULL OR v_reference_generation_id IS NULL OR v_shot_id IS NULL THEN
    RAISE EXCEPTION 'root_job_id, root_creative_run_id, request_id, reference_generation_id and shot_id are required';
  END IF;
  SELECT * INTO v_root FROM public.creative_runs WHERE id=v_root_run_id AND factory_job_id=v_root_job_id AND metadata->>'domain_kind'='game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root/job mismatch'; END IF;
  SELECT g.* INTO v_reference FROM public.generations g JOIN public.factory_jobs fj ON fj.id=g.factory_job_id
  WHERE g.id=v_reference_generation_id AND g.type='image' AND g.status='completed' AND fj.parent_job_id=v_root_job_id AND COALESCE((g.settings->>'stage4_reference')::BOOLEAN,false)=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'approved video requires a completed Stage 4 reference child'; END IF;
  IF v_reference.settings->>'shot_id' IS DISTINCT FROM v_shot_id THEN RAISE EXCEPTION 'reference generation does not belong to shot %',v_shot_id; END IF;
  SELECT r.* INTO v_review FROM public.gameplay_reference_reviews r WHERE r.root_creative_run_id=v_root_run_id AND r.generation_id=v_reference_generation_id ORDER BY r.created_at DESC LIMIT 1;
  IF NOT FOUND OR v_review.decision IS DISTINCT FROM 'approve' THEN RAISE EXCEPTION 'human APPROVE review is required before video generation'; END IF;
  SELECT item->>'url' INTO v_reference_url FROM jsonb_array_elements(COALESCE(v_reference.outputs,'[]'::JSONB)) item WHERE NULLIF(item->>'url','') IS NOT NULL LIMIT 1;
  IF v_reference_url IS NULL THEN RAISE EXCEPTION 'approved reference has no usable output URL'; END IF;
  v_concept_id := NULLIF(v_reference.settings->>'concept_id','');
  v_moment_id := NULLIF(v_reference.settings->>'moment_id','');
  SELECT * INTO v_concept FROM public.creative_runs WHERE parent_run_id=v_root_run_id AND metadata->>'domain_kind'='coop_game_concept' AND metadata->>'concept_id'=v_concept_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'concept run not found for approved reference'; END IF;
  IF v_concept.outputs->'gameplay_shot'->>'shotId' IS DISTINCT FROM v_shot_id THEN RAISE EXCEPTION 'approved reference is no longer aligned to the active shot'; END IF;
  IF v_concept.outputs->'prompt_plan'->>'shotId' IS DISTINCT FROM v_shot_id THEN RAISE EXCEPTION 'approved reference is no longer aligned to the active prompt plan'; END IF;
  v_video_prompt := COALESCE(v_video_prompt_override,NULLIF(v_concept.outputs#>>'{prompt_plan,videoPrompt}',''));
  v_video_model := COALESCE(NULLIF(v_concept.outputs#>>'{gameplay_shot,generationPlan,videoModel}',''),'kling-3');
  v_duration_sec := COALESCE(NULLIF(v_concept.outputs#>>'{gameplay_shot,generationPlan,durationSec}','')::INTEGER,5);
  IF v_video_prompt IS NULL THEN RAISE EXCEPTION 'video prompt is missing for approved shot'; END IF;
  IF v_video_model = 'kling-3' AND v_duration_sec NOT IN (5,10,15) THEN
    RAISE EXCEPTION 'Kling 3 gameplay duration must be one of 5, 10, 15 seconds';
  END IF;

  SELECT public.orchestrator_create_video_generation(jsonb_build_object(
    'request_id',v_request_id,'user_id',v_root.user_id,'project_id',v_root.project_id,'prompt',v_video_prompt,'model_id',v_video_model,'mode','image-to-video',
    'settings',jsonb_build_object('aspectRatio','16:9','durationSec',v_duration_sec,'effectiveQuality','pro','sound',false,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9','root_creative_run_id',v_root_run_id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id,'video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id),
    'reference_assets',jsonb_build_array(jsonb_build_object('id',v_reference_generation_id,'url',v_reference_url,'role','start_frame')),
    'action_input',jsonb_build_object('source',CASE WHEN v_video_revision_number>0 THEN 'stage4_game_discovery_human_video_revision' ELSE 'stage4_game_discovery_approved_reference' END,'source_capture_format','desktop_pc_16x9','root_creative_run_id',v_root_run_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id,'video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id,'duration_sec',v_duration_sec)
  )) INTO v_result;
  v_video_generation_id := NULLIF(v_result#>>'{generation,id}','')::UUID;
  v_child_job_id := NULLIF(v_result->>'factory_job_id','')::UUID;
  IF v_video_generation_id IS NULL OR v_child_job_id IS NULL THEN RAISE EXCEPTION 'durable gameplay video admission returned no generation/job id'; END IF;
  UPDATE public.factory_jobs SET parent_job_id=v_root_job_id,
    input=COALESCE(input,'{}'::JSONB)||jsonb_build_object('parent_job_id',v_root_job_id,'root_creative_run_id',v_root_run_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9','video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id,'duration_sec',v_duration_sec),
    state=COALESCE(state,'{}'::JSONB)||jsonb_build_object('parent_job_id',v_root_job_id,'root_creative_run_id',v_root_run_id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9','video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id,'duration_sec',v_duration_sec)
  WHERE id=v_child_job_id;
  v_request_entry := jsonb_build_object('request_id',v_request_id,'generation_id',v_video_generation_id,'factory_job_id',v_child_job_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'model_id',v_video_model,'aspect_ratio','16:9','duration_sec',v_duration_sec,'effective_quality','pro','approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id,'video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id,'created_at',NOW());
  UPDATE public.creative_runs SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object('gameplay_video_requests',COALESCE(outputs->'gameplay_video_requests','{}'::JSONB)||jsonb_build_object(v_shot_id,v_request_entry),'gameplay_video_request_history',COALESCE(outputs->'gameplay_video_request_history','[]'::JSONB)||jsonb_build_array(v_request_entry)) WHERE id=v_root_run_id;
  UPDATE public.creative_runs SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object('gameplay_video_request',v_request_entry) WHERE id=v_concept.id;
  INSERT INTO public.factory_workflow_events(job_id,event_type,dedupe_key,payload,creative_run_id)
  VALUES(v_root_job_id,CASE WHEN v_video_revision_number>0 THEN 'discovery.video_revision_admitted' ELSE 'discovery.approved_video_admitted' END,'stage4:approved-video:'||v_request_id::TEXT,v_request_entry,v_root_run_id)
  ON CONFLICT(dedupe_key) DO NOTHING;
  RETURN v_result||jsonb_build_object('root_job_id',v_root_job_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'video_revision_number',v_video_revision_number,'duration_sec',v_duration_sec);
END;
$function$;

UPDATE public.deployment_schema_contract
SET schema_version='20260822062000', updated_at=NOW()
WHERE singleton=TRUE;