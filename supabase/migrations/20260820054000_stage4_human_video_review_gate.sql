CREATE TABLE IF NOT EXISTS public.gameplay_video_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_creative_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  concept_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  generation_id UUID REFERENCES public.generations(id) ON DELETE SET NULL,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_reference_generation_id UUID REFERENCES public.generations(id) ON DELETE SET NULL,
  concept_id TEXT NOT NULL,
  moment_id TEXT NOT NULL,
  shot_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','revise')),
  raw_feedback TEXT,
  structured_feedback JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_tags JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(error_tags) = 'array'),
  must_show JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(must_show) = 'array'),
  must_avoid JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(must_avoid) = 'array'),
  reusable_scope TEXT NOT NULL DEFAULT 'concept' CHECK (reusable_scope IN ('shot','concept','project')),
  model TEXT,
  usage JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gameplay_video_reviews_root_created
  ON public.gameplay_video_reviews(root_creative_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gameplay_video_reviews_concept_created
  ON public.gameplay_video_reviews(concept_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gameplay_video_reviews_generation_user
  ON public.gameplay_video_reviews(generation_id, user_id)
  WHERE generation_id IS NOT NULL AND user_id IS NOT NULL;

ALTER TABLE public.gameplay_video_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gameplay_video_reviews FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.gameplay_video_reviews TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_record_gameplay_video_review(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_concept_run_id UUID := NULLIF(payload->>'concept_run_id', '')::UUID;
  v_generation_id UUID := NULLIF(payload->>'generation_id', '')::UUID;
  v_user_id UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_decision TEXT := NULLIF(trim(payload->>'decision'), '');
  v_structured JSONB := COALESCE(payload->'structured_feedback', '{}'::JSONB);
  v_review public.gameplay_video_reviews%ROWTYPE;
  v_root public.creative_runs%ROWTYPE;
  v_concept public.creative_runs%ROWTYPE;
  v_generation public.generations%ROWTYPE;
  v_job public.factory_jobs%ROWTYPE;
  v_current_request JSONB;
  v_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
BEGIN
  IF v_root_run_id IS NULL OR v_concept_run_id IS NULL OR v_generation_id IS NULL
     OR v_user_id IS NULL OR v_decision IS NULL THEN
    RAISE EXCEPTION 'root_creative_run_id, concept_run_id, generation_id, user_id and decision are required';
  END IF;
  IF v_decision NOT IN ('approve', 'reject', 'revise') THEN
    RAISE EXCEPTION 'invalid decision';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND OR v_root.factory_job_id IS NULL THEN
    RAISE EXCEPTION 'game discovery root creative run not found';
  END IF;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE id = v_root.factory_job_id;
  IF NOT FOUND OR v_job.status IN ('completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'game discovery job is not reviewable';
  END IF;
  IF v_job.current_stage IS DISTINCT FROM 'human_video_approval_pending' THEN
    RAISE EXCEPTION 'video review is allowed only at the active human video approval gate';
  END IF;

  SELECT * INTO v_concept
  FROM public.creative_runs
  WHERE id = v_concept_run_id
    AND parent_run_id = v_root_run_id
    AND metadata->>'domain_kind' = 'coop_game_concept';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'concept run is not a child of discovery root';
  END IF;

  SELECT g.* INTO v_generation
  FROM public.generations g
  JOIN public.factory_jobs fj ON fj.id = g.factory_job_id
  WHERE g.id = v_generation_id
    AND g.type = 'video'
    AND g.status = 'completed'
    AND fj.parent_job_id = v_root.factory_job_id
    AND COALESCE((g.settings->>'stage4_gameplay_video')::BOOLEAN, false) = true
    AND g.settings->>'root_creative_run_id' = v_root_run_id::TEXT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'generation is not a completed Stage 4 gameplay video child of this discovery batch';
  END IF;

  v_current_request := v_root.outputs->'gameplay_video_requests'->(v_generation.settings->>'shot_id');
  IF v_current_request IS NULL
     OR v_current_request->>'generation_id' IS DISTINCT FROM v_generation_id::TEXT THEN
    RAISE EXCEPTION 'generation is not the current gameplay video for this shot';
  END IF;

  IF NULLIF(trim(payload->>'concept_id'), '') IS DISTINCT FROM v_generation.settings->>'concept_id'
     OR NULLIF(trim(payload->>'shot_id'), '') IS DISTINCT FROM v_generation.settings->>'shot_id'
     OR NULLIF(trim(payload->>'moment_id'), '') IS DISTINCT FROM v_generation.settings->>'moment_id' THEN
    RAISE EXCEPTION 'review payload lineage does not match gameplay video generation';
  END IF;
  IF v_concept.metadata->>'concept_id' IS DISTINCT FROM v_generation.settings->>'concept_id' THEN
    RAISE EXCEPTION 'video generation concept lineage mismatch';
  END IF;

  INSERT INTO public.gameplay_video_reviews (
    root_creative_run_id, concept_run_id, generation_id, user_id,
    approved_reference_generation_id, concept_id, moment_id, shot_id,
    decision, raw_feedback, structured_feedback, error_tags, must_show,
    must_avoid, reusable_scope, model, usage
  )
  VALUES (
    v_root_run_id, v_concept_run_id, v_generation_id, v_user_id,
    NULLIF(v_generation.settings->>'approved_reference_generation_id', '')::UUID,
    v_generation.settings->>'concept_id', v_generation.settings->>'moment_id',
    v_generation.settings->>'shot_id', v_decision, NULLIF(payload->>'raw_feedback', ''),
    v_structured, COALESCE(v_structured->'errorTags', '[]'::JSONB),
    COALESCE(v_structured->'mustShow', '[]'::JSONB),
    COALESCE(v_structured->'mustAvoid', '[]'::JSONB),
    COALESCE(NULLIF(v_structured->>'reusableScope', ''), 'concept'),
    NULLIF(trim(payload->>'model'), ''), COALESCE(payload->'usage', '{}'::JSONB)
  )
  ON CONFLICT (generation_id, user_id)
    WHERE generation_id IS NOT NULL AND user_id IS NOT NULL
  DO UPDATE SET
    decision = EXCLUDED.decision,
    raw_feedback = EXCLUDED.raw_feedback,
    structured_feedback = EXCLUDED.structured_feedback,
    error_tags = EXCLUDED.error_tags,
    must_show = EXCLUDED.must_show,
    must_avoid = EXCLUDED.must_avoid,
    reusable_scope = EXCLUDED.reusable_scope,
    model = EXCLUDED.model,
    usage = EXCLUDED.usage,
    created_at = NOW()
  RETURNING * INTO v_review;

  SELECT msg_id INTO v_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object('v',1,'job_id',v_job.id,'reason','gameplay_video_review_recorded','trace_id',v_trace_id),
    0
  ) AS msg_id;

  UPDATE public.factory_jobs SET last_enqueued_at = NOW() WHERE id = v_job.id;

  INSERT INTO public.factory_workflow_events (job_id,event_type,dedupe_key,payload,creative_run_id)
  VALUES (
    v_job.id,'job.enqueued',
    'stage4:video-review:wakeup:' || v_review.id::TEXT || ':' || extract(epoch from v_review.created_at)::BIGINT::TEXT,
    jsonb_build_object('queue','core_orchestrator_v1','queue_msg_id',v_msg_id,'reason','gameplay_video_review_recorded','review_id',v_review.id,'generation_id',v_generation_id,'decision',v_decision,'trace_id',v_trace_id),
    v_root_run_id
  ) ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('review',to_jsonb(v_review),'queue_msg_id',v_msg_id,'trace_id',v_trace_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.orchestrator_get_gameplay_video_approval_stage(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id','')::UUID;
  v_root public.creative_runs%ROWTYPE;
  v_items JSONB;
BEGIN
  IF v_root_run_id IS NULL THEN RAISE EXCEPTION 'root_creative_run_id is required'; END IF;
  SELECT * INTO v_root FROM public.creative_runs
  WHERE id=v_root_run_id AND metadata->>'domain_kind'='game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found'; END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY shot_id),'[]'::JSONB) INTO v_items
  FROM (
    SELECT req.key AS shot_id,
      jsonb_build_object(
        'shot_id',req.key,'concept_id',req.value->>'concept_id','moment_id',req.value->>'moment_id',
        'concept_run_id',req.value->>'concept_run_id','generation_id',g.id,'factory_job_id',g.factory_job_id,
        'approved_reference_generation_id',req.value->>'approved_reference_generation_id','generation_status',g.status,
        'outputs',COALESCE(g.outputs,'[]'::JSONB),'error_message',g.error_message,'model_id',g.model_id,
        'decision',review.decision,'review_id',review.id,'raw_feedback',review.raw_feedback,
        'structured_feedback',COALESCE(review.structured_feedback,'{}'::JSONB),'created_at',g.created_at,'completed_at',g.completed_at
      ) AS item
    FROM jsonb_each(COALESCE(v_root.outputs->'gameplay_video_requests','{}'::JSONB)) req
    LEFT JOIN public.generations g ON g.id=NULLIF(req.value->>'generation_id','')::UUID
    LEFT JOIN LATERAL (
      SELECT r.* FROM public.gameplay_video_reviews r
      WHERE r.root_creative_run_id=v_root_run_id AND r.generation_id=g.id
      ORDER BY r.created_at DESC LIMIT 1
    ) review ON TRUE
  ) rows;

  RETURN jsonb_build_object(
    'items',v_items,'request_count',jsonb_array_length(v_items),
    'all_reviewed',jsonb_array_length(v_items)>0 AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(COALESCE(v_root.outputs->'gameplay_video_requests','{}'::JSONB)) req
      LEFT JOIN public.generations g ON g.id=NULLIF(req.value->>'generation_id','')::UUID
      LEFT JOIN LATERAL (
        SELECT r.decision FROM public.gameplay_video_reviews r
        WHERE r.root_creative_run_id=v_root_run_id AND r.generation_id=g.id
        ORDER BY r.created_at DESC LIMIT 1
      ) review ON TRUE
      WHERE g.id IS NULL OR g.status <> 'completed' OR review.decision IS NULL
    ),
    'all_approved',jsonb_array_length(v_items)>0 AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(COALESCE(v_root.outputs->'gameplay_video_requests','{}'::JSONB)) req
      LEFT JOIN public.generations g ON g.id=NULLIF(req.value->>'generation_id','')::UUID
      LEFT JOIN LATERAL (
        SELECT r.decision FROM public.gameplay_video_reviews r
        WHERE r.root_creative_run_id=v_root_run_id AND r.generation_id=g.id
        ORDER BY r.created_at DESC LIMIT 1
      ) review ON TRUE
      WHERE g.id IS NULL OR g.status <> 'completed' OR review.decision IS DISTINCT FROM 'approve'
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.orchestrator_get_game_discovery_feedback_memory(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_root public.creative_runs%ROWTYPE;
  v_items JSONB;
BEGIN
  IF v_root_run_id IS NULL THEN RAISE EXCEPTION 'root_creative_run_id is required'; END IF;
  SELECT * INTO v_root FROM public.creative_runs
  WHERE id = v_root_run_id AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found'; END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY created_at ASC), '[]'::JSONB) INTO v_items
  FROM (
    SELECT created_at,item FROM (
      SELECT r.created_at,
        jsonb_build_object('id',r.id,'media_kind','reference_image','concept_id',r.concept_id,'moment_id',r.moment_id,'shot_id',r.shot_id,'decision',r.decision,'structured_feedback',r.structured_feedback,'error_tags',r.error_tags,'must_show',r.must_show,'must_avoid',r.must_avoid,'reusable_scope',r.reusable_scope) AS item
      FROM public.gameplay_reference_reviews r
      JOIN public.creative_runs review_root ON review_root.id=r.root_creative_run_id
      WHERE r.root_creative_run_id=v_root_run_id
         OR (r.reusable_scope='project' AND v_root.project_id IS NOT NULL AND review_root.project_id=v_root.project_id)
      UNION ALL
      SELECT r.created_at,
        jsonb_build_object('id',r.id,'media_kind','video','concept_id',r.concept_id,'moment_id',r.moment_id,'shot_id',r.shot_id,'decision',r.decision,'structured_feedback',r.structured_feedback,'error_tags',r.error_tags,'must_show',r.must_show,'must_avoid',r.must_avoid,'reusable_scope',r.reusable_scope) AS item
      FROM public.gameplay_video_reviews r
      JOIN public.creative_runs review_root ON review_root.id=r.root_creative_run_id
      WHERE r.root_creative_run_id=v_root_run_id
         OR (r.reusable_scope='project' AND v_root.project_id IS NOT NULL AND review_root.project_id=v_root.project_id)
    ) combined
    ORDER BY created_at DESC LIMIT 100
  ) rows;
  RETURN jsonb_build_object('items',v_items);
END;
$function$;

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
  IF v_video_prompt IS NULL THEN RAISE EXCEPTION 'video prompt is missing for approved shot'; END IF;

  SELECT public.orchestrator_create_video_generation(jsonb_build_object(
    'request_id',v_request_id,'user_id',v_root.user_id,'project_id',v_root.project_id,'prompt',v_video_prompt,'model_id',v_video_model,'mode','image-to-video',
    'settings',jsonb_build_object('aspectRatio','16:9','durationSec',5,'effectiveQuality','pro','sound',false,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9','root_creative_run_id',v_root_run_id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id,'video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id),
    'reference_assets',jsonb_build_array(jsonb_build_object('id',v_reference_generation_id,'url',v_reference_url,'role','start_frame')),
    'action_input',jsonb_build_object('source',CASE WHEN v_video_revision_number>0 THEN 'stage4_game_discovery_human_video_revision' ELSE 'stage4_game_discovery_approved_reference' END,'source_capture_format','desktop_pc_16x9','root_creative_run_id',v_root_run_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id,'video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id)
  )) INTO v_result;
  v_video_generation_id := NULLIF(v_result#>>'{generation,id}','')::UUID;
  v_child_job_id := NULLIF(v_result->>'factory_job_id','')::UUID;
  IF v_video_generation_id IS NULL OR v_child_job_id IS NULL THEN RAISE EXCEPTION 'durable gameplay video admission returned no generation/job id'; END IF;
  UPDATE public.factory_jobs SET parent_job_id=v_root_job_id,
    input=COALESCE(input,'{}'::JSONB)||jsonb_build_object('parent_job_id',v_root_job_id,'root_creative_run_id',v_root_run_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9','video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id),
    state=COALESCE(state,'{}'::JSONB)||jsonb_build_object('parent_job_id',v_root_job_id,'root_creative_run_id',v_root_run_id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'stage4_gameplay_video',true,'source_capture_format','desktop_pc_16x9','video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id)
  WHERE id=v_child_job_id;
  v_request_entry := jsonb_build_object('request_id',v_request_id,'generation_id',v_video_generation_id,'factory_job_id',v_child_job_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'model_id',v_video_model,'aspect_ratio','16:9','effective_quality','pro','approved_reference_generation_id',v_reference_generation_id,'approved_review_id',v_review.id,'video_revision_number',v_video_revision_number,'source_video_generation_id',v_source_video_generation_id,'revision_review_id',v_revision_review_id,'created_at',NOW());
  UPDATE public.creative_runs SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object('gameplay_video_requests',COALESCE(outputs->'gameplay_video_requests','{}'::JSONB)||jsonb_build_object(v_shot_id,v_request_entry),'gameplay_video_request_history',COALESCE(outputs->'gameplay_video_request_history','[]'::JSONB)||jsonb_build_array(v_request_entry)) WHERE id=v_root_run_id;
  UPDATE public.creative_runs SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object('gameplay_video_request',v_request_entry) WHERE id=v_concept.id;
  INSERT INTO public.factory_workflow_events(job_id,event_type,dedupe_key,payload,creative_run_id)
  VALUES(v_root_job_id,CASE WHEN v_video_revision_number>0 THEN 'discovery.video_revision_admitted' ELSE 'discovery.approved_video_admitted' END,'stage4:approved-video:'||v_request_id::TEXT,v_request_entry,v_root_run_id)
  ON CONFLICT(dedupe_key) DO NOTHING;
  RETURN v_result||jsonb_build_object('root_job_id',v_root_job_id,'concept_run_id',v_concept.id,'concept_id',v_concept_id,'moment_id',v_moment_id,'shot_id',v_shot_id,'approved_reference_generation_id',v_reference_generation_id,'video_revision_number',v_video_revision_number);
END;
$function$;

REVOKE ALL ON FUNCTION public.orchestrator_record_gameplay_video_review(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_gameplay_video_review(JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.orchestrator_get_gameplay_video_approval_stage(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_gameplay_video_approval_stage(JSONB) TO service_role;
