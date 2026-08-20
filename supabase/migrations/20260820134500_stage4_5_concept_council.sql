-- Stage 4.5 PR5 — durable Concept Council fan-out + evidence-linked curation.
-- Three independent Concept Designers run on the existing research worker pool.
-- One bounded Curator step consumes their typed outputs and the active Evidence Pack.
-- Stage 4 game_discovery_batch@1 and all existing Human Gates remain untouched.

CREATE TABLE IF NOT EXISTS public.concept_council_assignments (
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  evidence_pack_id UUID NOT NULL REFERENCES public.research_packs(id) ON DELETE RESTRICT,
  designer_role TEXT NOT NULL CHECK (
    designer_role IN ('mechanics_explorer','social_viral_designer','buildable_systems_designer')
  ),
  factory_job_id UUID NOT NULL UNIQUE REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  creative_run_id UUID NOT NULL UNIQUE REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  objective JSONB NOT NULL CHECK (jsonb_typeof(objective) = 'object'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, designer_role)
);

CREATE INDEX IF NOT EXISTS idx_concept_council_assignments_job
  ON public.concept_council_assignments(factory_job_id);
CREATE INDEX IF NOT EXISTS idx_concept_council_assignments_pack
  ON public.concept_council_assignments(evidence_pack_id, designer_role);

CREATE TABLE IF NOT EXISTS public.concept_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  evidence_pack_id UUID NOT NULL REFERENCES public.research_packs(id) ON DELETE RESTRICT,
  designer_role TEXT NOT NULL CHECK (
    designer_role IN ('mechanics_explorer','social_viral_designer','buildable_systems_designer')
  ),
  creative_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  spec JSONB NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_candidates_pack
  ON public.concept_candidates(evidence_pack_id, designer_role, created_at);
CREATE INDEX IF NOT EXISTS idx_concept_candidates_concept
  ON public.concept_candidates(run_id, concept_id);

CREATE TABLE IF NOT EXISTS public.concept_council_curations (
  run_id UUID PRIMARY KEY REFERENCES public.research_runs(id) ON DELETE CASCADE,
  evidence_pack_id UUID NOT NULL REFERENCES public.research_packs(id) ON DELETE RESTRICT,
  batch JSONB NOT NULL CHECK (jsonb_typeof(batch) = 'object'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.curated_concept_evidence (
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  evidence_id UUID NOT NULL REFERENCES public.research_evidence(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, card_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_curated_concept_evidence_evidence
  ON public.curated_concept_evidence(evidence_id, run_id);

ALTER TABLE public.concept_council_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concept_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concept_council_curations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.curated_concept_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.concept_council_assignments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.concept_candidates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.concept_council_curations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.curated_concept_evidence FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.concept_council_assignments TO service_role;
GRANT ALL ON TABLE public.concept_candidates TO service_role;
GRANT ALL ON TABLE public.concept_council_curations TO service_role;
GRANT ALL ON TABLE public.curated_concept_evidence TO service_role;

COMMENT ON TABLE public.concept_council_assignments IS
  'Durable identity for exactly three Stage 4.5 Concept Designer child jobs.';
COMMENT ON TABLE public.concept_candidates IS
  'Evidence-linked raw Concept Council hypotheses before curation. Not Human-approved concepts.';
COMMENT ON TABLE public.concept_council_curations IS
  'One restart-safe final six-card Concept Council curation per ResearchRun.';
COMMENT ON TABLE public.curated_concept_evidence IS
  'Relational lineage from final grounded Game Cards to ResearchEvidence.';

-- ---------------------------------------------------------------------------
-- Three-way durable fan-out. The Evidence Pack is already persisted and immutable
-- for this run when the Concept Council starts. Duplicate parent retries reuse the
-- exact child job/run identity for each designer role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.concept_council_fanout(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_research_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_evidence_pack_id UUID := NULLIF(payload->>'evidence_pack_id', '')::UUID;
  v_objective JSONB := COALESCE(payload->'objective', '{}'::JSONB);
  v_run RECORD;
  v_pack RECORD;
  v_root_job RECORD;
  v_role TEXT;
  v_existing RECORD;
  v_child_job_id UUID;
  v_child_creative_run_id UUID;
  v_request_id UUID;
  v_trace_id UUID;
  v_msg_id BIGINT;
  v_items JSONB := '[]'::JSONB;
BEGIN
  IF v_research_run_id IS NULL OR v_evidence_pack_id IS NULL THEN
    RAISE EXCEPTION 'research_run_id and evidence_pack_id are required';
  END IF;
  IF jsonb_typeof(v_objective) <> 'object'
    OR COALESCE(v_objective->>'schema', '') <> 'discovery_objective'
    OR COALESCE((v_objective->>'version')::INTEGER, 0) <> 1
  THEN
    RAISE EXCEPTION 'objective must be DiscoveryObjectiveSpec v1';
  END IF;

  SELECT rr.id, rr.factory_job_id, rr.root_creative_run_id, rr.objective_id, rr.status
  INTO v_run
  FROM public.research_runs AS rr
  WHERE rr.id = v_research_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research run not found: %', v_research_run_id;
  END IF;
  IF v_run.status IN ('failed','cancelled') THEN
    RAISE EXCEPTION 'Cannot start Concept Council for % research run', v_run.status;
  END IF;
  IF v_objective->>'objectiveId' IS DISTINCT FROM v_run.objective_id THEN
    RAISE EXCEPTION 'Discovery objective ID does not match ResearchRun';
  END IF;

  SELECT rp.id, rp.run_id, rp.pack, rp.active
  INTO v_pack
  FROM public.research_packs AS rp
  WHERE rp.id = v_evidence_pack_id
    AND rp.run_id = v_research_run_id
    AND rp.active = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active Evidence Pack not found for Concept Council';
  END IF;
  IF v_pack.pack->>'packId' IS DISTINCT FROM v_evidence_pack_id::TEXT
    OR v_pack.pack->>'researchRunId' IS DISTINCT FROM v_research_run_id::TEXT
  THEN
    RAISE EXCEPTION 'Evidence Pack lineage mismatch';
  END IF;

  SELECT fj.id, fj.user_id, fj.project_id
  INTO v_root_job
  FROM public.factory_jobs AS fj
  WHERE fj.id = v_run.factory_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Root factory job not found for ResearchRun';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'mechanics_explorer','social_viral_designer','buildable_systems_designer'
  ]
  LOOP
    SELECT cca.factory_job_id, cca.creative_run_id
    INTO v_existing
    FROM public.concept_council_assignments AS cca
    WHERE cca.run_id = v_research_run_id
      AND cca.designer_role = v_role;

    IF FOUND THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'designer_role', v_role,
        'factory_job_id', v_existing.factory_job_id,
        'creative_run_id', v_existing.creative_run_id,
        'duplicate', true,
        'queue_msg_id', NULL
      ));
      CONTINUE;
    END IF;

    v_child_job_id := gen_random_uuid();
    v_child_creative_run_id := gen_random_uuid();
    v_request_id := gen_random_uuid();
    v_trace_id := gen_random_uuid();

    INSERT INTO public.factory_jobs (
      id, request_id, project_id, user_id, workflow_kind, workflow_version,
      status, current_stage, input, state, next_action_at
    ) VALUES (
      v_child_job_id,
      v_request_id,
      v_root_job.project_id,
      v_root_job.user_id,
      'concept_council_member',
      1,
      'queued',
      'concept_council_assigned',
      jsonb_build_object(
        'research_run_id', v_research_run_id,
        'evidence_pack_id', v_evidence_pack_id,
        'designer_role', v_role,
        'root_factory_job_id', v_run.factory_job_id,
        'root_creative_run_id', v_run.root_creative_run_id,
        'objective', v_objective
      ),
      jsonb_build_object(
        'research_run_id', v_research_run_id,
        'evidence_pack_id', v_evidence_pack_id,
        'designer_role', v_role,
        'phase', 'assigned'
      ),
      NOW()
    );

    INSERT INTO public.creative_runs (
      id, user_id, project_id, parent_run_id, factory_job_id, run_type,
      status, title, objective, parameters, inputs, metadata
    ) VALUES (
      v_child_creative_run_id,
      v_root_job.user_id,
      v_root_job.project_id,
      v_run.root_creative_run_id,
      v_child_job_id,
      'research',
      'queued',
      'Concept Designer: ' || v_role,
      v_run.objective_id,
      jsonb_build_object('designer_role', v_role),
      jsonb_build_object(
        'research_run_id', v_research_run_id,
        'evidence_pack_id', v_evidence_pack_id,
        'objective', v_objective
      ),
      jsonb_build_object(
        'research_run_id', v_research_run_id,
        'evidence_pack_id', v_evidence_pack_id,
        'designer_role', v_role,
        'workflow_kind', 'concept_council_member',
        'workflow_version', 1
      )
    );

    INSERT INTO public.concept_council_assignments (
      run_id, evidence_pack_id, designer_role, factory_job_id, creative_run_id, objective
    ) VALUES (
      v_research_run_id, v_evidence_pack_id, v_role, v_child_job_id, v_child_creative_run_id, v_objective
    );

    SELECT msg_id INTO v_msg_id
    FROM pgmq.send(
      'research_orchestrator_v1',
      jsonb_build_object(
        'v', 1,
        'job_id', v_child_job_id,
        'reason', 'concept_council_member_created',
        'trace_id', v_trace_id
      ),
      0
    ) AS msg_id;

    UPDATE public.factory_jobs
    SET last_enqueued_at = NOW()
    WHERE id = v_child_job_id;

    INSERT INTO public.factory_workflow_events (
      job_id, creative_run_id, event_type, dedupe_key, payload
    ) VALUES (
      v_child_job_id,
      v_child_creative_run_id,
      'job.enqueued',
      'queue:enqueued:' || v_msg_id::TEXT,
      jsonb_build_object(
        'queue', 'research_orchestrator_v1',
        'queue_msg_id', v_msg_id,
        'reason', 'concept_council_member_created',
        'research_run_id', v_research_run_id,
        'evidence_pack_id', v_evidence_pack_id,
        'designer_role', v_role,
        'trace_id', v_trace_id
      )
    );

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'designer_role', v_role,
      'factory_job_id', v_child_job_id,
      'creative_run_id', v_child_creative_run_id,
      'duplicate', false,
      'queue_msg_id', v_msg_id
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'research_run_id', v_research_run_id,
    'evidence_pack_id', v_evidence_pack_id,
    'status', 'waiting_designers',
    'designer_count', jsonb_array_length(v_items),
    'designers', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.concept_council_fanout(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.concept_council_fanout(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Child job context. Persisted output is returned before executor invocation so a
-- worker crash after output persistence cannot repeat the model call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.concept_council_begin_member_job(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT
    cca.run_id,
    cca.evidence_pack_id,
    cca.designer_role,
    cca.creative_run_id,
    cca.objective,
    rr.factory_job_id AS root_factory_job_id,
    rr.root_creative_run_id,
    rp.pack AS evidence_pack,
    cr.outputs->'concept_designer_output' AS existing_output
  INTO v_row
  FROM public.concept_council_assignments AS cca
  JOIN public.research_runs AS rr ON rr.id = cca.run_id
  JOIN public.research_packs AS rp ON rp.id = cca.evidence_pack_id
  JOIN public.creative_runs AS cr ON cr.id = cca.creative_run_id
  WHERE cca.factory_job_id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Concept Council assignment not found for job %', p_job_id;
  END IF;

  RETURN jsonb_build_object(
    'research_run_id', v_row.run_id,
    'evidence_pack_id', v_row.evidence_pack_id,
    'designer_role', v_row.designer_role,
    'creative_run_id', v_row.creative_run_id,
    'root_factory_job_id', v_row.root_factory_job_id,
    'root_creative_run_id', v_row.root_creative_run_id,
    'objective', v_row.objective,
    'evidence_pack', v_row.evidence_pack,
    'existing_output', v_row.existing_output
  );
END;
$$;

REVOKE ALL ON FUNCTION public.concept_council_begin_member_job(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.concept_council_begin_member_job(UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Persist one Designer output and its raw candidates before factory job completion.
-- Exact retry is idempotent. A different second output for an already committed role
-- is rejected instead of silently rewriting the first paid result.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.concept_council_persist_member_output(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_output JSONB := COALESCE(payload->'output', '{}'::JSONB);
  v_provider TEXT := NULLIF(payload->>'provider', '');
  v_model TEXT := NULLIF(payload->>'model', '');
  v_usage JSONB := COALESCE(payload->'usage', '{}'::JSONB);
  v_assignment RECORD;
  v_existing JSONB;
  v_candidate JSONB;
  v_evidence_id_text TEXT;
  v_source_id_text TEXT;
BEGIN
  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'job_id is required';
  END IF;
  IF jsonb_typeof(v_output) <> 'object'
    OR COALESCE(v_output->>'schema', '') <> 'concept_designer_output'
    OR COALESCE((v_output->>'version')::INTEGER, 0) <> 1
  THEN
    RAISE EXCEPTION 'Invalid Concept Designer output schema/version';
  END IF;
  IF jsonb_typeof(v_usage) <> 'object' THEN
    RAISE EXCEPTION 'usage must be an object';
  END IF;

  SELECT
    cca.run_id,
    cca.evidence_pack_id,
    cca.designer_role,
    cca.creative_run_id,
    cr.outputs->'concept_designer_output' AS existing_output
  INTO v_assignment
  FROM public.concept_council_assignments AS cca
  JOIN public.creative_runs AS cr ON cr.id = cca.creative_run_id
  WHERE cca.factory_job_id = v_job_id
  FOR UPDATE OF cca, cr;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Concept Council assignment not found for job %', v_job_id;
  END IF;

  IF v_output->>'researchRunId' IS DISTINCT FROM v_assignment.run_id::TEXT
    OR v_output->>'evidencePackId' IS DISTINCT FROM v_assignment.evidence_pack_id::TEXT
    OR v_output->>'designerRole' IS DISTINCT FROM v_assignment.designer_role
  THEN
    RAISE EXCEPTION 'Concept Designer output lineage mismatch';
  END IF;
  IF jsonb_typeof(v_output->'candidates') <> 'array'
    OR jsonb_array_length(v_output->'candidates') < 1
    OR jsonb_array_length(v_output->'candidates') > 4
  THEN
    RAISE EXCEPTION 'Concept Designer must persist between one and four candidates';
  END IF;

  v_existing := v_assignment.existing_output;
  IF v_existing IS NOT NULL THEN
    IF v_existing IS DISTINCT FROM v_output THEN
      RAISE EXCEPTION 'Concept Designer output already committed with different content';
    END IF;
    RETURN jsonb_build_object('persisted', true, 'duplicate', true, 'output', v_existing);
  END IF;

  FOR v_candidate IN
    SELECT item
    FROM jsonb_array_elements(v_output->'candidates') AS candidate(item)
  LOOP
    IF COALESCE(v_candidate->>'schema', '') <> 'concept_hypothesis'
      OR COALESCE((v_candidate->>'version')::INTEGER, 0) <> 1
      OR v_candidate->>'researchRunId' IS DISTINCT FROM v_assignment.run_id::TEXT
      OR v_candidate->>'evidencePackId' IS DISTINCT FROM v_assignment.evidence_pack_id::TEXT
      OR v_candidate->>'designerRole' IS DISTINCT FROM v_assignment.designer_role
    THEN
      RAISE EXCEPTION 'Invalid Concept Hypothesis lineage';
    END IF;
    IF COALESCE(v_candidate#>>'{coOpDependencyTest,mechanicallyNecessary}', 'false') <> 'true' THEN
      RAISE EXCEPTION 'Concept Hypothesis requires mechanically necessary co-op dependency';
    END IF;
    IF jsonb_typeof(v_candidate->'supportingEvidenceIds') <> 'array'
      OR jsonb_array_length(v_candidate->'supportingEvidenceIds') < 3
      OR jsonb_array_length(v_candidate->'supportingEvidenceIds') > 8
    THEN
      RAISE EXCEPTION 'Concept Hypothesis requires 3-8 evidence IDs';
    END IF;
    IF NULLIF(v_candidate->>'whatIsNew', '') IS NULL
      OR jsonb_typeof(v_candidate->'whatMustNotCopy') <> 'array'
      OR jsonb_array_length(v_candidate->'whatMustNotCopy') < 1
    THEN
      RAISE EXCEPTION 'Concept Hypothesis requires whatIsNew and whatMustNotCopy';
    END IF;

    FOR v_evidence_id_text IN
      SELECT value
      FROM jsonb_array_elements_text(v_candidate->'supportingEvidenceIds') AS ids(value)
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM public.research_pack_evidence AS rpe
        WHERE rpe.pack_id = v_assignment.evidence_pack_id
          AND rpe.evidence_id = v_evidence_id_text::UUID
      ) THEN
        RAISE EXCEPTION 'Concept Hypothesis contains orphan Evidence Pack evidence ID: %', v_evidence_id_text;
      END IF;
    END LOOP;

    IF jsonb_typeof(v_candidate->'closestAnalogs') <> 'array'
      OR jsonb_array_length(v_candidate->'closestAnalogs') < 1
    THEN
      RAISE EXCEPTION 'Concept Hypothesis requires at least one closest analog';
    END IF;

    FOR v_source_id_text IN
      SELECT sid.value
      FROM jsonb_array_elements(v_candidate->'closestAnalogs') AS analog(item)
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(analog.item->'sourceIds', '[]'::JSONB)) AS sid(value)
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM public.research_run_sources AS rrs
        WHERE rrs.run_id = v_assignment.run_id
          AND rrs.source_id = v_source_id_text::UUID
      ) THEN
        RAISE EXCEPTION 'Concept Hypothesis closest analog contains orphan source ID: %', v_source_id_text;
      END IF;
    END LOOP;

    INSERT INTO public.concept_candidates (
      run_id, evidence_pack_id, designer_role, creative_run_id,
      candidate_id, concept_id, spec
    ) VALUES (
      v_assignment.run_id,
      v_assignment.evidence_pack_id,
      v_assignment.designer_role,
      v_assignment.creative_run_id,
      v_candidate->>'candidateId',
      v_candidate#>>'{concept,conceptId}',
      v_candidate
    );
  END LOOP;

  UPDATE public.creative_runs
  SET
    outputs = outputs || jsonb_build_object('concept_designer_output', v_output),
    metadata = metadata || jsonb_build_object(
      'concept_council_provider', v_provider,
      'concept_council_model', v_model,
      'concept_council_usage', v_usage,
      'concept_candidate_count', jsonb_array_length(v_output->'candidates')
    ),
    updated_at = NOW()
  WHERE id = v_assignment.creative_run_id;

  RETURN jsonb_build_object('persisted', true, 'duplicate', false, 'output', v_output);
END;
$$;

REVOKE ALL ON FUNCTION public.concept_council_persist_member_output(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.concept_council_persist_member_output(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Fan-in status. Parent orchestration can wait for all three durable children without
-- relying on process-local Promise state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.concept_council_get_fanout_status(p_research_run_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH rows AS (
    SELECT
      cca.evidence_pack_id,
      cca.designer_role,
      cca.factory_job_id,
      cca.creative_run_id,
      fj.status AS job_status,
      fj.retry_count,
      fj.error,
      cr.outputs->'concept_designer_output' AS output
    FROM public.concept_council_assignments AS cca
    JOIN public.factory_jobs AS fj ON fj.id = cca.factory_job_id
    JOIN public.creative_runs AS cr ON cr.id = cca.creative_run_id
    WHERE cca.run_id = p_research_run_id
  )
  SELECT jsonb_build_object(
    'research_run_id', p_research_run_id,
    'evidence_pack_id', (SELECT evidence_pack_id FROM rows LIMIT 1),
    'designer_count', COUNT(*),
    'terminal_count', COUNT(*) FILTER (WHERE job_status IN ('completed','failed','cancelled')),
    'completed_count', COUNT(*) FILTER (WHERE job_status = 'completed'),
    'failed_count', COUNT(*) FILTER (WHERE job_status = 'failed'),
    'all_terminal', COUNT(*) = 3 AND COUNT(*) FILTER (WHERE job_status IN ('completed','failed','cancelled')) = 3,
    'items', COALESCE(jsonb_agg(jsonb_build_object(
      'designer_role', designer_role,
      'factory_job_id', factory_job_id,
      'creative_run_id', creative_run_id,
      'job_status', job_status,
      'retry_count', retry_count,
      'error', error,
      'output', output
    ) ORDER BY designer_role), '[]'::JSONB)
  )
  FROM rows;
$$;

REVOKE ALL ON FUNCTION public.concept_council_get_fanout_status(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.concept_council_get_fanout_status(UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- One final six-card curation. DB validates lineage and every supporting evidence
-- pointer against the exact Evidence Pack, then stores relational evidence lineage.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.concept_council_persist_curated_batch(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_research_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_batch JSONB := COALESCE(payload->'batch', '{}'::JSONB);
  v_metadata JSONB := COALESCE(payload->'metadata', '{}'::JSONB);
  v_pack_id UUID;
  v_existing JSONB;
  v_card JSONB;
  v_evidence_id_text TEXT;
BEGIN
  IF v_research_run_id IS NULL THEN
    RAISE EXCEPTION 'research_run_id is required';
  END IF;
  IF jsonb_typeof(v_batch) <> 'object'
    OR COALESCE(v_batch->>'schema', '') <> 'curated_concept_batch'
    OR COALESCE((v_batch->>'version')::INTEGER, 0) <> 1
  THEN
    RAISE EXCEPTION 'Invalid curated Concept Council batch schema/version';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'metadata must be an object';
  END IF;
  IF v_batch->>'researchRunId' IS DISTINCT FROM v_research_run_id::TEXT THEN
    RAISE EXCEPTION 'Curated Concept Council batch ResearchRun mismatch';
  END IF;
  v_pack_id := NULLIF(v_batch->>'evidencePackId', '')::UUID;
  IF v_pack_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.research_packs
    WHERE id = v_pack_id AND run_id = v_research_run_id
  ) THEN
    RAISE EXCEPTION 'Curated Concept Council batch Evidence Pack mismatch';
  END IF;
  IF jsonb_typeof(v_batch->'cards') <> 'array'
    OR jsonb_array_length(v_batch->'cards') <> 6
  THEN
    RAISE EXCEPTION 'Concept Curator must persist exactly six grounded Game Cards';
  END IF;
  IF COALESCE((v_batch->>'rawCandidateCount')::INTEGER, 0) < 6
    OR COALESCE((v_batch->>'rawCandidateCount')::INTEGER, 0) > 12
  THEN
    RAISE EXCEPTION 'Curated Concept Council rawCandidateCount must be 6-12';
  END IF;

  SELECT batch INTO v_existing
  FROM public.concept_council_curations
  WHERE run_id = v_research_run_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing IS DISTINCT FROM v_batch THEN
      RAISE EXCEPTION 'Concept Council curation already committed with different content';
    END IF;
    RETURN jsonb_build_object('persisted', true, 'duplicate', true, 'batch', v_existing);
  END IF;

  FOR v_card IN
    SELECT item
    FROM jsonb_array_elements(v_batch->'cards') AS card(item)
  LOOP
    IF COALESCE(v_card->>'schema', '') <> 'grounded_game_card'
      OR COALESCE((v_card->>'version')::INTEGER, 0) <> 1
      OR v_card#>>'{researchContext,researchRunId}' IS DISTINCT FROM v_research_run_id::TEXT
      OR v_card#>>'{researchContext,evidencePackId}' IS DISTINCT FROM v_pack_id::TEXT
    THEN
      RAISE EXCEPTION 'Grounded Game Card lineage mismatch';
    END IF;
    IF jsonb_typeof(v_card#>'{researchContext,supportingEvidenceIds}') <> 'array'
      OR jsonb_array_length(v_card#>'{researchContext,supportingEvidenceIds}') < 3
      OR jsonb_array_length(v_card#>'{researchContext,supportingEvidenceIds}') > 5
      OR jsonb_typeof(v_card->'evidenceBullets') <> 'array'
      OR jsonb_array_length(v_card->'evidenceBullets') < 3
      OR jsonb_array_length(v_card->'evidenceBullets') > 5
    THEN
      RAISE EXCEPTION 'Grounded Game Card requires 3-5 research evidence bullets';
    END IF;
    IF jsonb_typeof(v_card->'whatMustNotCopy') <> 'array'
      OR jsonb_array_length(v_card->'whatMustNotCopy') < 1
      OR NULLIF(v_card->>'intentionalDifference', '') IS NULL
    THEN
      RAISE EXCEPTION 'Grounded Game Card requires intentionalDifference and whatMustNotCopy';
    END IF;

    FOR v_evidence_id_text IN
      SELECT value
      FROM jsonb_array_elements_text(v_card#>'{researchContext,supportingEvidenceIds}') AS ids(value)
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM public.research_pack_evidence AS rpe
        WHERE rpe.pack_id = v_pack_id
          AND rpe.evidence_id = v_evidence_id_text::UUID
      ) THEN
        RAISE EXCEPTION 'Grounded Game Card contains orphan Evidence Pack evidence ID: %', v_evidence_id_text;
      END IF;
    END LOOP;
  END LOOP;

  INSERT INTO public.concept_council_curations(run_id, evidence_pack_id, batch, metadata)
  VALUES (v_research_run_id, v_pack_id, v_batch, v_metadata);

  FOR v_card IN
    SELECT item
    FROM jsonb_array_elements(v_batch->'cards') AS card(item)
  LOOP
    FOR v_evidence_id_text IN
      SELECT value
      FROM jsonb_array_elements_text(v_card#>'{researchContext,supportingEvidenceIds}') AS ids(value)
    LOOP
      INSERT INTO public.curated_concept_evidence(run_id, card_id, evidence_id)
      VALUES (v_research_run_id, v_card->>'cardId', v_evidence_id_text::UUID)
      ON CONFLICT (run_id, card_id, evidence_id) DO NOTHING;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('persisted', true, 'duplicate', false, 'batch', v_batch);
END;
$$;

REVOKE ALL ON FUNCTION public.concept_council_persist_curated_batch(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.concept_council_persist_curated_batch(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.concept_council_get_curated_batch(p_research_run_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN ccc.run_id IS NULL THEN jsonb_build_object('batch', NULL)
    ELSE jsonb_build_object(
      'research_run_id', ccc.run_id,
      'evidence_pack_id', ccc.evidence_pack_id,
      'batch', ccc.batch,
      'metadata', ccc.metadata,
      'created_at', ccc.created_at
    )
  END
  FROM (SELECT p_research_run_id AS requested_run) AS request
  LEFT JOIN public.concept_council_curations AS ccc
    ON ccc.run_id = request.requested_run;
$$;

REVOKE ALL ON FUNCTION public.concept_council_get_curated_batch(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.concept_council_get_curated_batch(UUID)
  TO service_role;
