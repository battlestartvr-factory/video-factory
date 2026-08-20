-- Stage 4.5 PR7 — Game Discovery v2 integration.
-- Adds a new root workflow version without changing game_discovery_batch@1 admission.
-- Research/Concept Council output is persisted into the existing Stage 4 concept surface,
-- so all three existing Human Gates and downstream Stage 4 handlers remain authoritative.

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_runs_one_per_factory_job
  ON public.research_runs(factory_job_id);

-- ---------------------------------------------------------------------------
-- Explicit v2 admission. V1 remains on orchestrator_create_game_discovery_batch().
-- PR8 production acceptance decides when/if v2 becomes the product default.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_create_game_discovery_batch_v2(payload JSONB)
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
  IF jsonb_typeof(v_objective) <> 'object' OR v_objective = '{}'::JSONB THEN
    RAISE EXCEPTION 'discovery_objective object is required';
  END IF;
  IF v_objective->>'schema' IS DISTINCT FROM 'discovery_objective'
     OR v_objective->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'unsupported discovery_objective schema/version';
  END IF;
  IF jsonb_typeof(v_policy) <> 'object' OR COALESCE(v_policy->>'mode', '') NOT IN ('required','best_effort','disabled') THEN
    RAISE EXCEPTION 'valid research_policy object is required';
  END IF;
  IF v_title IS NULL OR v_search_intent IS NULL THEN
    RAISE EXCEPTION 'discovery objective title and searchIntent are required';
  END IF;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE request_id = v_request_id;

  IF FOUND THEN
    IF v_job.user_id IS DISTINCT FROM v_user_id
       OR v_job.workflow_kind IS DISTINCT FROM 'game_discovery_batch'
       OR v_job.workflow_version IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'request_id collision with another workflow';
    END IF;

    SELECT * INTO v_creative_run
    FROM public.creative_runs
    WHERE factory_job_id = v_job.id
      AND metadata->>'domain_kind' = 'game_discovery_batch'
    ORDER BY created_at ASC
    LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'duplicate discovery batch is missing creative run'; END IF;

    RETURN jsonb_build_object(
      'creative_run', to_jsonb(v_creative_run),
      'factory_job_id', v_job.id,
      'duplicate', true,
      'queue_msg_id', NULL,
      'trace_id', NULL
    );
  END IF;

  INSERT INTO public.creative_runs (
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
      'workflow_version', 2,
      'research_enabled', (v_policy->>'mode') <> 'disabled',
      'request_id', v_request_id
    )
  ) RETURNING * INTO v_creative_run;

  INSERT INTO public.factory_jobs (
    request_id, project_id, user_id, workflow_kind, workflow_version,
    status, current_stage, progress, input, state, next_action_at
  ) VALUES (
    v_request_id,
    v_project_id,
    v_user_id,
    'game_discovery_batch',
    2,
    'queued',
    'research_planning',
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
      'reason', 'game_discovery_v2_created',
      'trace_id', v_trace_id
    ),
    0
  ) AS msg_id;

  UPDATE public.factory_jobs SET last_enqueued_at = NOW() WHERE id = v_job.id;

  INSERT INTO public.factory_workflow_events(
    job_id, event_type, dedupe_key, payload, creative_run_id
  ) VALUES (
    v_job.id,
    'job.enqueued',
    'queue:enqueued:' || v_msg_id::TEXT,
    jsonb_build_object(
      'queue', 'core_orchestrator_v1',
      'queue_msg_id', v_msg_id,
      'reason', 'game_discovery_v2_created',
      'workflow_version', 2,
      'creative_run_id', v_creative_run.id,
      'trace_id', v_trace_id
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

REVOKE ALL ON FUNCTION public.orchestrator_create_game_discovery_batch_v2(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_create_game_discovery_batch_v2(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- One ResearchRun per v2 root. The root factory job remains the workflow owner.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_begin_game_discovery_v2_research(payload JSONB)
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
  IF jsonb_typeof(v_policy) <> 'object' OR COALESCE(v_policy->>'mode', '') NOT IN ('required','best_effort') THEN
    RAISE EXCEPTION 'enabled v2 research requires required/best_effort research policy';
  END IF;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE id = v_job_id
    AND workflow_kind = 'game_discovery_batch'
    AND workflow_version = 2
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'game_discovery_batch@2 job not found'; END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'v2 root creative run/job mismatch'; END IF;

  SELECT * INTO v_research
  FROM public.research_runs
  WHERE factory_job_id = v_job_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'research_run_id', v_research.id,
      'status', v_research.status,
      'duplicate', true
    );
  END IF;

  INSERT INTO public.research_runs(
    factory_job_id,
    root_creative_run_id,
    objective_id,
    status,
    plan,
    budget,
    coverage,
    cost,
    metadata
  ) VALUES (
    v_job_id,
    v_root_run_id,
    v_objective->>'objectiveId',
    'planned',
    '{}'::JSONB,
    jsonb_build_object(
      'max_queries', COALESCE((v_policy->>'maxQueries')::INTEGER, 20),
      'max_sources', COALESCE((v_policy->>'maxSources')::INTEGER, 30),
      'max_image_candidates', COALESCE((v_policy->>'maxImageCandidates')::INTEGER, 24)
    ),
    '{}'::JSONB,
    '{}'::JSONB,
    jsonb_build_object(
      'research_policy', v_policy,
      'workflow_kind', 'game_discovery_batch',
      'workflow_version', 2
    )
  ) RETURNING * INTO v_research;

  UPDATE public.creative_runs
  SET outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
    'research_run_id', v_research.id,
    'research_policy', v_policy
  )
  WHERE id = v_root_run_id;

  RETURN jsonb_build_object(
    'research_run_id', v_research.id,
    'status', v_research.status,
    'duplicate', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_begin_game_discovery_v2_research(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_begin_game_discovery_v2_research(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Persist the Curator's six cards into the exact Stage 4 concept surface consumed
-- by the existing human concept gate and all downstream handlers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_persist_game_discovery_v2_concepts(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_pack JSONB := COALESCE(payload->'evidence_pack', '{}'::JSONB);
  v_batch JSONB := COALESCE(payload->'curated_batch', '{}'::JSONB);
  v_metadata JSONB := COALESCE(payload->'metadata', '{}'::JSONB);
  v_cards JSONB := COALESCE(v_batch->'cards', '[]'::JSONB);
  v_job public.factory_jobs%ROWTYPE;
  v_root public.creative_runs%ROWTYPE;
  v_card JSONB;
  v_concept JSONB;
  v_concept_id TEXT;
  v_child public.creative_runs%ROWTYPE;
  v_children JSONB := '[]'::JSONB;
  v_concepts JSONB := '[]'::JSONB;
  v_grounding JSONB := '{}'::JSONB;
BEGIN
  IF v_job_id IS NULL OR v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'job_id and root_creative_run_id are required';
  END IF;
  IF v_pack->>'schema' IS DISTINCT FROM 'evidence_pack' OR v_pack->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'valid EvidencePack v1 is required';
  END IF;
  IF v_batch->>'schema' IS DISTINCT FROM 'curated_concept_batch' OR v_batch->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'valid curated concept batch v1 is required';
  END IF;
  IF jsonb_typeof(v_cards) <> 'array' OR jsonb_array_length(v_cards) <> 6 THEN
    RAISE EXCEPTION 'Game Discovery v2 Curator must persist exactly six cards';
  END IF;
  IF v_batch->>'researchRunId' IS DISTINCT FROM v_pack->>'researchRunId'
     OR v_batch->>'evidencePackId' IS DISTINCT FROM v_pack->>'packId' THEN
    RAISE EXCEPTION 'curated batch / EvidencePack lineage mismatch';
  END IF;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE id = v_job_id
    AND workflow_kind = 'game_discovery_batch'
    AND workflow_version = 2
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'game_discovery_batch@2 job not found'; END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'v2 root creative run/job mismatch'; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.research_runs rr
    WHERE rr.id = NULLIF(v_pack->>'researchRunId', '')::UUID
      AND (rr.factory_job_id <> v_job_id OR rr.root_creative_run_id <> v_root_run_id)
  ) THEN
    RAISE EXCEPTION 'EvidencePack ResearchRun does not belong to this v2 root';
  END IF;

  FOR v_card IN SELECT value FROM jsonb_array_elements(v_cards)
  LOOP
    IF v_card->>'schema' IS DISTINCT FROM 'grounded_game_card' OR v_card->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'invalid grounded game card';
    END IF;
    v_concept := v_card->'concept';
    IF v_concept->>'schema' IS DISTINCT FROM 'coop_game_concept' OR v_concept->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'grounded card contains invalid coop_game_concept';
    END IF;
    v_concept_id := NULLIF(trim(v_concept->>'conceptId'), '');
    IF v_concept_id IS NULL THEN RAISE EXCEPTION 'curated concept is missing conceptId'; END IF;

    SELECT * INTO v_child
    FROM public.creative_runs
    WHERE parent_run_id = v_root_run_id
      AND metadata->>'domain_kind' = 'coop_game_concept'
      AND metadata->>'concept_id' = v_concept_id
    ORDER BY created_at ASC
    LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO public.creative_runs(
        user_id, project_id, parent_run_id, factory_job_id, run_type, status,
        title, objective, hypothesis, model, provider, inputs, outputs, metadata, completed_at
      ) VALUES (
        v_root.user_id,
        v_root.project_id,
        v_root_run_id,
        v_job_id,
        'concept',
        'completed',
        NULLIF(v_concept->>'oneSentencePitch', ''),
        v_root.objective,
        NULLIF(v_concept->>'coopDependency', ''),
        COALESCE(NULLIF(v_metadata->>'model', ''), 'stage4_5_concept_curator_v1'),
        COALESCE(NULLIF(v_metadata->>'provider', ''), 'research_council'),
        jsonb_build_object(
          'discovery_objective', v_root.inputs->'discovery_objective',
          'research_run_id', v_pack->>'researchRunId',
          'evidence_pack_id', v_pack->>'packId'
        ),
        jsonb_build_object(
          'coop_game_concept', v_concept,
          'research_context', v_card->'researchContext',
          'grounded_game_card', v_card
        ),
        jsonb_build_object(
          'domain_kind', 'coop_game_concept',
          'domain_schema', 'coop_game_concept',
          'domain_version', 1,
          'concept_id', v_concept_id,
          'root_discovery_run_id', v_root_run_id,
          'research_run_id', v_pack->>'researchRunId',
          'evidence_pack_id', v_pack->>'packId',
          'grounded_card_id', v_card->>'cardId',
          'source_stage', 's4_5_concept_curator'
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

    v_children := v_children || jsonb_build_array(jsonb_build_object(
      'run_id', v_child.id,
      'concept_id', v_concept_id
    ));
    v_concepts := v_concepts || jsonb_build_array(v_concept);
    v_grounding := v_grounding || jsonb_build_object(v_concept_id, v_card);
  END LOOP;

  UPDATE public.creative_runs
  SET
    status = 'running',
    model = COALESCE(NULLIF(v_metadata->>'model', ''), model, 'stage4_5_concept_curator_v1'),
    provider = COALESCE(NULLIF(v_metadata->>'provider', ''), provider, 'research_council'),
    outputs = COALESCE(outputs, '{}'::JSONB) || jsonb_build_object(
      'discovery_concepts', v_concepts,
      'diversity_rejections', COALESCE(v_batch->'rejectedCandidateIds', '[]'::JSONB),
      'concept_explorer', jsonb_build_object(
        'source', 'stage4_5_concept_council',
        'research_run_id', v_pack->>'researchRunId',
        'evidence_pack_id', v_pack->>'packId',
        'raw_candidate_count', v_batch->'rawCandidateCount',
        'curated_count', 6,
        'usage', COALESCE(v_metadata->'usage', '{}'::JSONB)
      ),
      'concept_runs', v_children,
      'research_run_id', v_pack->>'researchRunId',
      'evidence_pack_id', v_pack->>'packId',
      'research_coverage', COALESCE(v_pack->'coverage', '{}'::JSONB),
      'research_grounding_by_concept', v_grounding
    ),
    usage = COALESCE(usage, '{}'::JSONB) || jsonb_build_object(
      'concept_council', COALESCE(v_metadata->'usage', '{}'::JSONB)
    )
  WHERE id = v_root_run_id;

  INSERT INTO public.factory_workflow_events(
    job_id, event_type, dedupe_key, payload, creative_run_id
  ) VALUES (
    v_job_id,
    'discovery.v2_concepts_persisted',
    'stage4.5:pr7:curated-concepts-persisted',
    jsonb_build_object(
      'research_run_id', v_pack->>'researchRunId',
      'evidence_pack_id', v_pack->>'packId',
      'accepted_count', 6,
      'concept_runs', v_children
    ),
    v_root_run_id
  )
  ON CONFLICT (job_id, dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'root_creative_run_id', v_root_run_id,
    'concept_runs', v_children,
    'accepted_count', 6
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_game_discovery_v2_concepts(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_game_discovery_v2_concepts(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_mark_game_discovery_v2_research_failure(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_code TEXT := COALESCE(NULLIF(trim(payload->>'code'), ''), 'RESEARCH_FAILED');
  v_message TEXT := COALESCE(NULLIF(trim(payload->>'message'), ''), 'Research did not meet the v2 coverage policy');
  v_coverage JSONB := COALESCE(payload->'coverage', '{}'::JSONB);
  v_best_effort BOOLEAN := COALESCE((payload->>'best_effort_fallback')::BOOLEAN, false);
BEGIN
  IF v_run_id IS NULL THEN RAISE EXCEPTION 'research_run_id is required'; END IF;

  UPDATE public.research_runs
  SET
    status = 'failed',
    coverage = v_coverage,
    error = jsonb_build_object(
      'code', v_code,
      'message', v_message,
      'best_effort_fallback', v_best_effort
    ),
    completed_at = COALESCE(completed_at, NOW()),
    updated_at = NOW(),
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
      'best_effort_fallback', v_best_effort
    )
  WHERE id = v_run_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'research run not found'; END IF;
  RETURN jsonb_build_object('research_run_id', v_run_id, 'status', 'failed');
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_mark_game_discovery_v2_research_failure(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_mark_game_discovery_v2_research_failure(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Compatibility seam for the existing Human Concept Gate's Revise/Reject path and
-- best_effort/disabled Stage 4 baseline fallback. The body is intentionally the
-- existing Stage 4 persistence contract with only workflow_version widened to (1,2).
-- V1 callers retain identical behavior.
-- ---------------------------------------------------------------------------
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
  IF jsonb_typeof(v_rejected) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'rejections must be an array'; END IF;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE id = v_job_id
    AND workflow_kind = 'game_discovery_batch'
    AND workflow_version IN (1, 2);
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery factory job not found'; END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND factory_job_id = v_job_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found or job mismatch'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_accepted)
  LOOP
    IF v_item->>'schema' IS DISTINCT FROM 'coop_game_concept' OR v_item->>'version' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'unsupported coop_game_concept schema/version';
    END IF;
    v_concept_id := NULLIF(trim(v_item->>'conceptId'), '');
    IF v_concept_id IS NULL THEN RAISE EXCEPTION 'accepted concept is missing conceptId'; END IF;

    SELECT * INTO v_child
    FROM public.creative_runs
    WHERE parent_run_id = v_root_run_id
      AND metadata->>'domain_kind' = 'coop_game_concept'
      AND metadata->>'concept_id' = v_concept_id
    ORDER BY created_at ASC LIMIT 1;

    IF NOT FOUND THEN
      INSERT INTO public.creative_runs(
        user_id, project_id, parent_run_id, factory_job_id, run_type, status,
        title, objective, hypothesis, model, provider, inputs, outputs, metadata, completed_at
      ) VALUES (
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
        jsonb_build_object('discovery_objective', v_root.inputs->'discovery_objective'),
        jsonb_build_object('coop_game_concept', v_item),
        jsonb_build_object(
          'domain_kind', 'coop_game_concept',
          'domain_schema', 'coop_game_concept',
          'domain_version', 1,
          'concept_id', v_concept_id,
          'root_discovery_run_id', v_root_run_id,
          'source_stage', CASE WHEN v_job.workflow_version = 2 THEN 's4_5_human_concept_revision' ELSE 's4_003_concept_explorer' END
        ),
        NOW()
      ) ON CONFLICT DO NOTHING RETURNING * INTO v_child;

      IF NOT FOUND THEN
        SELECT * INTO v_child
        FROM public.creative_runs
        WHERE parent_run_id = v_root_run_id
          AND metadata->>'domain_kind' = 'coop_game_concept'
          AND metadata->>'concept_id' = v_concept_id
        ORDER BY created_at ASC LIMIT 1;
      END IF;
    END IF;

    v_children := v_children || jsonb_build_array(jsonb_build_object(
      'run_id', v_child.id,
      'concept_id', v_concept_id
    ));
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

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload, creative_run_id)
  VALUES (
    v_job_id,
    'discovery.concepts_persisted',
    'stage4:s4-003:concepts-persisted:' || COALESCE(v_explorer->>'review_cycle', 'initial'),
    jsonb_build_object(
      'creative_run_id', v_root_run_id,
      'accepted_count', jsonb_array_length(v_accepted),
      'rejected_count', jsonb_array_length(v_rejected),
      'concept_runs', v_children,
      'model', COALESCE(v_model, 'claude-sonnet-5'),
      'workflow_version', v_job.workflow_version
    ),
    v_root_run_id
  ) ON CONFLICT (job_id, dedupe_key) DO NOTHING;

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
