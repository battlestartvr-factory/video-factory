-- Game Discovery v3: simplify the creative graph while preserving the durable Stage 4 shell.
-- New product path:
-- natural chat -> one bounded verified source pool -> Research Pack -> one strong LLM
-- -> exactly 3 concepts -> Human Concept Gate -> existing Stage 4 media/human gates.
-- V1/V2 functions and workflow rows remain intact for restart compatibility.

-- ---------------------------------------------------------------------------
-- V3 admission. Exactly three concepts are a product invariant for new runs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_create_game_discovery_batch_v3(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_request_id UUID := NULLIF(payload->>'request_id', '')::UUID;
  v_user_id UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_project_id UUID := NULLIF(payload->>'project_id', '')::UUID;
  v_objective JSONB := COALESCE(payload->'discovery_objective', '{}'::JSONB);
  v_policy JSONB := COALESCE(payload->'research_policy', '{}'::JSONB);
  v_title TEXT := NULLIF(trim(payload#>>'{discovery_objective,title}'), '');
  v_search_intent TEXT := NULLIF(trim(payload#>>'{discovery_objective,searchIntent}'), '');
  v_hypothesis TEXT := NULLIF(trim(payload->>'hypothesis'), '');
  v_creative_run public.creative_runs%ROWTYPE;
  v_job public.factory_jobs%ROWTYPE;
  v_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
BEGIN
  IF v_request_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_id and user_id are required';
  END IF;
  IF jsonb_typeof(v_objective) <> 'object'
     OR v_objective->>'schema' IS DISTINCT FROM 'discovery_objective'
     OR v_objective->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'valid discovery_objective v1 is required';
  END IF;
  IF COALESCE((v_objective->>'conceptCount')::INTEGER, 0) <> 3
     OR COALESCE((v_objective->>'maxConceptsToPrototype')::INTEGER, 0) <> 3 THEN
    RAISE EXCEPTION 'Game Discovery v3 requires conceptCount=3 and maxConceptsToPrototype=3';
  END IF;
  IF jsonb_typeof(v_policy) <> 'object' OR COALESCE(v_policy->>'mode', '') NOT IN ('required','best_effort') THEN
    RAISE EXCEPTION 'Game Discovery v3 requires bounded research';
  END IF;
  IF v_title IS NULL OR v_search_intent IS NULL THEN
    RAISE EXCEPTION 'discovery objective title and searchIntent are required';
  END IF;

  SELECT * INTO v_job FROM public.factory_jobs WHERE request_id = v_request_id;
  IF FOUND THEN
    IF v_job.user_id IS DISTINCT FROM v_user_id
       OR v_job.workflow_kind IS DISTINCT FROM 'game_discovery_batch'
       OR v_job.workflow_version IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'request_id collision with another workflow';
    END IF;
    SELECT * INTO v_creative_run
    FROM public.creative_runs
    WHERE factory_job_id = v_job.id AND metadata->>'domain_kind' = 'game_discovery_batch'
    ORDER BY created_at ASC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'duplicate v3 discovery batch is missing creative run'; END IF;
    RETURN jsonb_build_object(
      'creative_run', to_jsonb(v_creative_run),
      'factory_job_id', v_job.id,
      'duplicate', true,
      'queue_msg_id', NULL,
      'trace_id', NULL
    );
  END IF;

  INSERT INTO public.creative_runs(
    user_id, project_id, run_type, status, title, objective, hypothesis,
    inputs, outputs, metadata
  ) VALUES (
    v_user_id,
    v_project_id,
    'mixed',
    'queued',
    v_title,
    v_search_intent,
    COALESCE(v_hypothesis, v_search_intent),
    jsonb_build_object(
      'discovery_objective', v_objective,
      'research_policy', v_policy
    ),
    '{}'::JSONB,
    jsonb_build_object(
      'domain_kind', 'game_discovery_batch',
      'domain_schema', 'discovery_objective',
      'domain_version', 1,
      'workflow_version', 3,
      'creative_graph', 'simplified_v3',
      'request_id', v_request_id
    )
  ) RETURNING * INTO v_creative_run;

  INSERT INTO public.factory_jobs(
    request_id, project_id, user_id, workflow_kind, workflow_version,
    status, current_stage, progress, input, state, next_action_at
  ) VALUES (
    v_request_id,
    v_project_id,
    v_user_id,
    'game_discovery_batch',
    3,
    'queued',
    'research_acquisition',
    0,
    jsonb_build_object(
      'creative_run_id', v_creative_run.id,
      'discovery_objective', v_objective,
      'research_policy', v_policy
    ),
    jsonb_build_object(
      'creative_run_id', v_creative_run.id,
      'discovery_objective', v_objective,
      'research_policy', v_policy,
      'stage4_schema_version', 1,
      'stage4_5_schema_version', 1,
      'simplified_creative_graph', true,
      'strong_concept_model', 'gpt-5-6-terra',
      'human_concept_gate_required', true,
      'human_concept_gate_passed', false
    ),
    NOW()
  ) RETURNING * INTO v_job;

  UPDATE public.creative_runs
  SET factory_job_id = v_job.id
  WHERE id = v_creative_run.id
  RETURNING * INTO v_creative_run;

  SELECT msg_id INTO v_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object(
      'v', 1,
      'job_id', v_job.id,
      'reason', 'game_discovery_v3_created',
      'trace_id', v_trace_id
    ),
    0
  ) AS msg_id;

  UPDATE public.factory_jobs SET last_enqueued_at = NOW() WHERE id = v_job.id;

  INSERT INTO public.factory_workflow_events(job_id,event_type,dedupe_key,payload,creative_run_id)
  VALUES(
    v_job.id,
    'job.enqueued',
    'queue:enqueued:' || v_msg_id::TEXT,
    jsonb_build_object(
      'queue','core_orchestrator_v1',
      'queue_msg_id',v_msg_id,
      'reason','game_discovery_v3_created',
      'workflow_version',3,
      'creative_run_id',v_creative_run.id,
      'trace_id',v_trace_id
    ),
    v_creative_run.id
  );

  RETURN jsonb_build_object(
    'creative_run', to_jsonb(v_creative_run),
    'factory_job_id', v_job.id,
    'duplicate', false,
    'queue_msg_id', v_msg_id,
    'trace_id', v_trace_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_create_game_discovery_batch_v3(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_create_game_discovery_batch_v3(JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- One ResearchRun owned by the v3 root. The five old Scout child jobs are not created.
-- The legacy-shaped plan is only a bounded source-acquisition specification.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_begin_game_discovery_v3_research(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_objective JSONB := COALESCE(payload->'objective', '{}'::JSONB);
  v_policy JSONB := COALESCE(payload->'research_policy', '{}'::JSONB);
  v_plan JSONB := COALESCE(payload->'plan', '{}'::JSONB);
  v_job public.factory_jobs%ROWTYPE;
  v_root public.creative_runs%ROWTYPE;
  v_research public.research_runs%ROWTYPE;
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'job_id and root_creative_run_id are required';
  END IF;
  IF v_objective->>'schema' IS DISTINCT FROM 'discovery_objective'
     OR v_objective->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'valid discovery objective is required';
  END IF;
  IF v_plan->>'schema' IS DISTINCT FROM 'research_plan'
     OR v_plan->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'valid bounded Research Plan is required';
  END IF;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE id = v_job_id
    AND workflow_kind = 'game_discovery_batch'
    AND workflow_version = 3
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'game_discovery_batch@3 job not found'; END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'v3 root creative run/job mismatch'; END IF;

  SELECT * INTO v_research
  FROM public.research_runs
  WHERE factory_job_id = v_job_id;
  IF FOUND THEN
    -- On first admission the caller may only know a provisional id. Persist the final
    -- deterministic plan once the durable ResearchRun id is known.
    IF v_plan->>'researchRunId' = v_research.id::TEXT THEN
      UPDATE public.research_runs
      SET plan = v_plan, status = CASE WHEN status = 'planned' THEN 'running' ELSE status END,
          started_at = COALESCE(started_at, NOW()), updated_at = NOW()
      WHERE id = v_research.id;
    END IF;
    RETURN jsonb_build_object('research_run_id',v_research.id,'status',v_research.status,'duplicate',true);
  END IF;

  INSERT INTO public.research_runs(
    factory_job_id, root_creative_run_id, objective_id, status,
    plan, budget, coverage, cost, metadata, started_at
  ) VALUES (
    v_job_id,
    v_root_run_id,
    v_objective->>'objectiveId',
    'running',
    v_plan,
    jsonb_build_object(
      'max_queries', COALESCE((v_policy->>'maxQueries')::INTEGER, 20),
      'max_sources', COALESCE((v_policy->>'maxSources')::INTEGER, 30),
      'max_image_candidates', COALESCE((v_policy->>'maxImageCandidates')::INTEGER, 24),
      'creative_llm_calls', 1
    ),
    '{}'::JSONB,
    '{}'::JSONB,
    jsonb_build_object(
      'research_policy',v_policy,
      'workflow_kind','game_discovery_batch',
      'workflow_version',3,
      'architecture','single_shared_source_pool'
    ),
    NOW()
  ) RETURNING * INTO v_research;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs,'{}'::JSONB) || jsonb_build_object('research_run_id',v_research.id)
  WHERE id = v_root_run_id;

  RETURN jsonb_build_object('research_run_id',v_research.id,'status',v_research.status,'duplicate',false);
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_begin_game_discovery_v3_research(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_begin_game_discovery_v3_research(JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- Shared source-pool lease: preserve the v2 Scout owner rule, but also allow the
-- v3 ROOT job to own its single acquisition directly. This is the idempotency fence
-- preventing retries from starting duplicate paid searches.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.research_acquire_shared_source_pool(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_row public.research_shared_source_pools%ROWTYPE;
BEGIN
  IF v_run_id IS NULL OR v_job_id IS NULL THEN
    RAISE EXCEPTION 'research_run_id and job_id are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.research_runs WHERE id = v_run_id) THEN
    RAISE EXCEPTION 'research run not found: %', v_run_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.research_scout_assignments
    WHERE run_id = v_run_id AND factory_job_id = v_job_id
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.research_runs rr
    JOIN public.factory_jobs fj ON fj.id = rr.factory_job_id
    WHERE rr.id = v_run_id
      AND rr.factory_job_id = v_job_id
      AND fj.workflow_kind = 'game_discovery_batch'
      AND fj.workflow_version = 3
  ) THEN
    RAISE EXCEPTION 'job % is neither a Scout assignment nor a v3 root for research run %', v_job_id, v_run_id;
  END IF;

  INSERT INTO public.research_shared_source_pools(research_run_id)
  VALUES (v_run_id)
  ON CONFLICT (research_run_id) DO NOTHING;

  SELECT * INTO v_row
  FROM public.research_shared_source_pools
  WHERE research_run_id = v_run_id
  FOR UPDATE;

  IF v_row.status = 'ready' THEN
    RETURN jsonb_build_object('status','ready','acquired',false,'owner_job_id',v_row.owner_job_id,'pool',v_row.pool,'usage',v_row.usage,'error',NULL);
  END IF;
  IF v_row.status = 'failed' THEN
    RETURN jsonb_build_object('status','failed','acquired',false,'owner_job_id',v_row.owner_job_id,'pool',NULL,'usage',v_row.usage,'error',COALESCE(v_row.error,'{}'::JSONB));
  END IF;
  IF v_row.status = 'acquiring'
     AND v_row.owner_job_id IS DISTINCT FROM v_job_id
     AND v_row.lease_expires_at IS NOT NULL
     AND v_row.lease_expires_at > NOW() THEN
    RETURN jsonb_build_object('status','acquiring','acquired',false,'owner_job_id',v_row.owner_job_id,'lease_expires_at',v_row.lease_expires_at,'pool',NULL,'error',NULL);
  END IF;

  UPDATE public.research_shared_source_pools
  SET status='acquiring', owner_job_id=v_job_id,
      lease_expires_at=NOW()+INTERVAL '115 seconds', attempt_count=attempt_count+1,
      pool=NULL, usage='{}'::JSONB, error=NULL, updated_at=NOW()
  WHERE research_run_id=v_run_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('status','acquiring','acquired',true,'owner_job_id',v_job_id,'lease_expires_at',v_row.lease_expires_at,'attempt_count',v_row.attempt_count,'pool',NULL,'error',NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.research_acquire_shared_source_pool(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_acquire_shared_source_pool(JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- Persist one normalized Research Pack. No Synthesizer job is necessary: verified
-- source claims are compacted deterministically and the strong model analyzes the pack.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_persist_game_discovery_v3_research_pack(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_pack JSONB := COALESCE(payload->'research_pack', '{}'::JSONB);
  v_research_run_id UUID := NULLIF(v_pack->>'researchRunId','')::UUID;
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL OR v_research_run_id IS NULL THEN
    RAISE EXCEPTION 'job/root/research run ids are required';
  END IF;
  IF v_pack->>'schema' IS DISTINCT FROM 'game_discovery_research_pack'
     OR v_pack->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(v_pack->'sources') <> 'array'
     OR jsonb_array_length(v_pack->'sources') < 1
     OR jsonb_array_length(v_pack->'sources') > 12 THEN
    RAISE EXCEPTION 'valid Game Discovery Research Pack v1 is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.factory_jobs
    WHERE id=v_job_id AND workflow_kind='game_discovery_batch' AND workflow_version=3
  ) THEN RAISE EXCEPTION 'game_discovery_batch@3 job not found'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.creative_runs
    WHERE id=v_root_run_id AND factory_job_id=v_job_id AND metadata->>'domain_kind'='game_discovery_batch'
  ) THEN RAISE EXCEPTION 'v3 root creative run/job mismatch'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.research_runs
    WHERE id=v_research_run_id AND factory_job_id=v_job_id AND root_creative_run_id=v_root_run_id
  ) THEN RAISE EXCEPTION 'Research Pack does not belong to this v3 root'; END IF;

  UPDATE public.research_runs
  SET status='completed', coverage=COALESCE(v_pack->'coverage','{}'::JSONB),
      cost=COALESCE(v_pack->'usage','{}'::JSONB), completed_at=COALESCE(completed_at,NOW()),
      metadata=COALESCE(metadata,'{}'::JSONB)||jsonb_build_object('simple_research_pack',v_pack),
      updated_at=NOW()
  WHERE id=v_research_run_id;

  UPDATE public.creative_runs
  SET outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object(
    'research_run_id',v_research_run_id,
    'research_pack',v_pack,
    'research_coverage',COALESCE(v_pack->'coverage','{}'::JSONB)
  )
  WHERE id=v_root_run_id;

  INSERT INTO public.factory_workflow_events(job_id,event_type,dedupe_key,payload,creative_run_id)
  VALUES(
    v_job_id,
    'discovery.v3_research_pack_persisted',
    'discovery:v3:research-pack:'||v_job_id::TEXT,
    jsonb_build_object('research_run_id',v_research_run_id,'source_count',jsonb_array_length(v_pack->'sources')),
    v_root_run_id
  ) ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('research_run_id',v_research_run_id,'source_count',jsonb_array_length(v_pack->'sources'));
END;
$$;

CREATE OR REPLACE FUNCTION public.orchestrator_get_game_discovery_v3_research_pack(p_root_creative_run_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN cr.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'research_run_id', cr.outputs->>'research_run_id',
      'research_pack', cr.outputs->'research_pack'
    )
  END
  FROM (SELECT 1) AS singleton
  LEFT JOIN public.creative_runs cr
    ON cr.id=p_root_creative_run_id
   AND cr.metadata->>'domain_kind'='game_discovery_batch'
   AND cr.metadata->>'workflow_version'='3';
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_game_discovery_v3_research_pack(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_game_discovery_v3_research_pack(JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.orchestrator_get_game_discovery_v3_research_pack(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_game_discovery_v3_research_pack(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- One strong model persists exactly THREE concepts into the existing Stage 4 surface.
-- The old Designer/Curator tables are intentionally not populated for v3.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_persist_game_discovery_v3_concepts(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_pack JSONB := COALESCE(payload->'research_pack','{}'::JSONB);
  v_batch JSONB := COALESCE(payload->'concept_batch','{}'::JSONB);
  v_metadata JSONB := COALESCE(payload->'metadata','{}'::JSONB);
  v_candidates JSONB := COALESCE(v_batch->'concepts','[]'::JSONB);
  v_root public.creative_runs%ROWTYPE;
  v_candidate JSONB;
  v_concept JSONB;
  v_concept_id TEXT;
  v_child public.creative_runs%ROWTYPE;
  v_children JSONB := '[]'::JSONB;
  v_concepts JSONB := '[]'::JSONB;
  v_grounding JSONB := '{}'::JSONB;
  v_seen_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL THEN RAISE EXCEPTION 'job_id and root_creative_run_id are required'; END IF;
  IF v_pack->>'schema' IS DISTINCT FROM 'game_discovery_research_pack' OR v_pack->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'valid v3 Research Pack is required';
  END IF;
  IF v_batch->>'schema' IS DISTINCT FROM 'strong_concept_batch' OR v_batch->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'valid Strong Concept Batch v1 is required';
  END IF;
  IF jsonb_typeof(v_candidates) <> 'array' OR jsonb_array_length(v_candidates) <> 3 THEN
    RAISE EXCEPTION 'Game Discovery v3 must persist exactly three concepts';
  END IF;
  IF v_batch->>'researchRunId' IS DISTINCT FROM v_pack->>'researchRunId' THEN
    RAISE EXCEPTION 'Strong Concept Batch / Research Pack lineage mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.factory_jobs
    WHERE id=v_job_id AND workflow_kind='game_discovery_batch' AND workflow_version=3
  ) THEN RAISE EXCEPTION 'game_discovery_batch@3 job not found'; END IF;

  SELECT * INTO v_root FROM public.creative_runs
  WHERE id=v_root_run_id AND factory_job_id=v_job_id AND metadata->>'domain_kind'='game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'v3 root creative run/job mismatch'; END IF;

  FOR v_candidate IN SELECT value FROM jsonb_array_elements(v_candidates)
  LOOP
    v_concept := v_candidate->'concept';
    IF v_concept->>'schema' IS DISTINCT FROM 'coop_game_concept' OR v_concept->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'Strong Concept Batch contains invalid coop_game_concept';
    END IF;
    IF jsonb_typeof(v_candidate->'sourceRefs') <> 'array' OR jsonb_array_length(v_candidate->'sourceRefs') < 2 THEN
      RAISE EXCEPTION 'Every v3 concept requires at least two sourceRefs';
    END IF;
    v_concept_id := NULLIF(trim(v_concept->>'conceptId'),'');
    IF v_concept_id IS NULL THEN RAISE EXCEPTION 'v3 concept is missing conceptId'; END IF;
    IF v_concept_id = ANY(v_seen_ids) THEN RAISE EXCEPTION 'duplicate v3 conceptId: %',v_concept_id; END IF;
    v_seen_ids := array_append(v_seen_ids,v_concept_id);

    SELECT * INTO v_child FROM public.creative_runs
    WHERE parent_run_id=v_root_run_id
      AND metadata->>'domain_kind'='coop_game_concept'
      AND metadata->>'concept_id'=v_concept_id
    ORDER BY created_at ASC LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO public.creative_runs(
        user_id,project_id,parent_run_id,factory_job_id,run_type,status,
        title,objective,hypothesis,model,provider,inputs,outputs,metadata,completed_at
      ) VALUES (
        v_root.user_id,v_root.project_id,v_root_run_id,v_job_id,'concept','completed',
        NULLIF(v_concept->>'oneSentencePitch',''),v_root.objective,NULLIF(v_concept->>'coopDependency',''),
        COALESCE(NULLIF(v_metadata->>'model',''),'gpt-5-6-terra'),'kie',
        jsonb_build_object('discovery_objective',v_root.inputs->'discovery_objective','research_run_id',v_pack->>'researchRunId'),
        jsonb_build_object('coop_game_concept',v_concept,'research_context',v_candidate),
        jsonb_build_object(
          'domain_kind','coop_game_concept','domain_schema','coop_game_concept','domain_version',1,
          'concept_id',v_concept_id,'root_discovery_run_id',v_root_run_id,
          'research_run_id',v_pack->>'researchRunId','source_stage','v3_strong_concept_llm'
        ),NOW()
      ) ON CONFLICT DO NOTHING RETURNING * INTO v_child;
      IF NOT FOUND THEN
        SELECT * INTO v_child FROM public.creative_runs
        WHERE parent_run_id=v_root_run_id AND metadata->>'domain_kind'='coop_game_concept' AND metadata->>'concept_id'=v_concept_id
        ORDER BY created_at ASC LIMIT 1;
      END IF;
    END IF;

    v_children := v_children||jsonb_build_array(jsonb_build_object('run_id',v_child.id,'concept_id',v_concept_id));
    v_concepts := v_concepts||jsonb_build_array(v_concept);
    v_grounding := v_grounding||jsonb_build_object(v_concept_id,v_candidate);
  END LOOP;

  UPDATE public.creative_runs
  SET status='running', model=COALESCE(NULLIF(v_metadata->>'model',''),'gpt-5-6-terra'), provider='kie',
      outputs=COALESCE(outputs,'{}'::JSONB)||jsonb_build_object(
        'discovery_concepts',v_concepts,
        'diversity_rejections','[]'::JSONB,
        'concept_explorer',jsonb_build_object(
          'source','v3_strong_concept_llm',
          'research_run_id',v_pack->>'researchRunId',
          'requested_count',3,
          'generated_count',3,
          'accepted_count',3,
          'model',COALESCE(NULLIF(v_metadata->>'model',''),'gpt-5-6-terra'),
          'usage',COALESCE(v_metadata->'usage','{}'::JSONB),
          'attempts',COALESCE(v_metadata->'attempts','1'::JSONB)
        ),
        'concept_runs',v_children,
        'research_run_id',v_pack->>'researchRunId',
        'research_pack',v_pack,
        'research_coverage',COALESCE(v_pack->'coverage','{}'::JSONB),
        'research_grounding_by_concept',v_grounding
      ),
      usage=COALESCE(usage,'{}'::JSONB)||jsonb_build_object('strong_concept_llm',COALESCE(v_metadata->'usage','{}'::JSONB))
  WHERE id=v_root_run_id;

  INSERT INTO public.factory_workflow_events(job_id,event_type,dedupe_key,payload,creative_run_id)
  VALUES(
    v_job_id,
    'discovery.v3_concepts_persisted',
    'discovery:v3:concepts:'||v_job_id::TEXT,
    jsonb_build_object('research_run_id',v_pack->>'researchRunId','accepted_count',3,'concept_runs',v_children,'model',COALESCE(NULLIF(v_metadata->>'model',''),'gpt-5-6-terra')),
    v_root_run_id
  ) ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object('root_creative_run_id',v_root_run_id,'concept_runs',v_children,'accepted_count',3);
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_game_discovery_v3_concepts(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_game_discovery_v3_concepts(JSONB) TO service_role;

-- Human Concept Gate regeneration/revision persists through the existing authoritative
-- Stage 4 function. Widen its admission to v3 without creating another persistence path.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.orchestrator_persist_game_concept_exploration(jsonb)'::regprocedure) INTO v_def;
  IF v_def IS NULL THEN RAISE EXCEPTION 'orchestrator_persist_game_concept_exploration(jsonb) not found'; END IF;
  v_def := replace(v_def, 'workflow_version IN (1, 2)', 'workflow_version IN (1, 2, 3)');
  IF position('workflow_version IN (1, 2, 3)' in v_def)=0 THEN
    RAISE EXCEPTION 'failed to widen concept persistence admission to v3';
  END IF;
  EXECUTE v_def;
END $$;

UPDATE public.deployment_schema_contract
SET schema_version='20260821223000', updated_at=NOW()
WHERE singleton=TRUE;