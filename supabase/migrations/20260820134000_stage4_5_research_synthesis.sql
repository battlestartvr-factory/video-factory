-- Stage 4.5 PR4 — Atomic Research Evidence persistence + bounded EvidencePack provenance.
-- Research Memory remains evidence/index state. factory_jobs + creative_runs remain execution/lineage owners.
-- Fresh evidence is append-only; exact Scout retry duplicates reuse an existing evidence row rather than
-- rewriting the historical observation.

-- ---------------------------------------------------------------------------
-- Evidence idempotency/provenance additions.
-- ---------------------------------------------------------------------------
ALTER TABLE public.research_evidence
  ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT;

ALTER TABLE public.research_evidence
  DROP CONSTRAINT IF EXISTS research_evidence_fingerprint_format;
ALTER TABLE public.research_evidence
  ADD CONSTRAINT research_evidence_fingerprint_format
    CHECK (evidence_fingerprint IS NULL OR evidence_fingerprint ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_evidence_scout_fingerprint
  ON public.research_evidence(run_id, scout_role, evidence_fingerprint)
  WHERE evidence_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.research_scout_evidence_commits (
  run_id UUID NOT NULL,
  scout_role TEXT NOT NULL,
  bundle_hash TEXT NOT NULL CHECK (bundle_hash ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, scout_role),
  CONSTRAINT research_scout_evidence_commits_assignment_fkey
    FOREIGN KEY (run_id, scout_role)
    REFERENCES public.research_scout_assignments(run_id, scout_role)
    ON DELETE CASCADE
);

ALTER TABLE public.research_scout_evidence_commits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.research_scout_evidence_commits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.research_scout_evidence_commits TO service_role;

COMMENT ON TABLE public.research_scout_evidence_commits IS
  'Idempotent atomic commit marker for one Scout source/evidence bundle. A different hash for the same role is rejected.';

CREATE TABLE IF NOT EXISTS public.research_pack_evidence (
  pack_id UUID NOT NULL REFERENCES public.research_packs(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES public.research_evidence(id) ON DELETE RESTRICT,
  section TEXT NOT NULL CHECK (
    section IN (
      'marketLandscape','mechanicLandscape','playerPositiveSignals','playerPainSignals',
      'saturatedPatterns','whiteSpaces','counterexamples','gameplayReferencePatterns',
      'visualReferencePatterns','contradictions'
    )
  ),
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pack_id, evidence_id, section)
);

CREATE INDEX IF NOT EXISTS idx_research_pack_evidence_evidence
  ON public.research_pack_evidence(evidence_id, pack_id);

CREATE TABLE IF NOT EXISTS public.research_pack_sources (
  pack_id UUID NOT NULL REFERENCES public.research_packs(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pack_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_research_pack_sources_source
  ON public.research_pack_sources(source_id, pack_id);

ALTER TABLE public.research_pack_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_pack_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.research_pack_evidence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.research_pack_sources FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.research_pack_evidence TO service_role;
GRANT ALL ON TABLE public.research_pack_sources TO service_role;

COMMENT ON TABLE public.research_pack_evidence IS
  'Referential provenance from a bounded EvidencePack section to source-backed ResearchEvidence.';
COMMENT ON TABLE public.research_pack_sources IS
  'Referential provenance for selectedSourceIds in an EvidencePack.';

-- ---------------------------------------------------------------------------
-- Atomic Scout evidence bundle persistence.
-- A single transaction resolves/upserts canonical sources, links them to the run, appends/dedupes
-- evidence, writes evidence->source provenance, and finally records the commit hash.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.research_persist_scout_evidence_bundle(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_bundle_hash TEXT := lower(COALESCE(payload->>'bundle_hash', ''));
  v_bundle JSONB := COALESCE(payload->'bundle', '{}'::JSONB);
  v_assignment RECORD;
  v_existing RECORD;
  v_source JSONB;
  v_evidence JSONB;
  v_source_ref TEXT;
  v_evidence_ref TEXT;
  v_source_ref_text TEXT;
  v_source_id UUID;
  v_evidence_id UUID;
  v_source_map JSONB := '{}'::JSONB;
  v_evidence_map JSONB := '{}'::JSONB;
  v_final_evidence JSONB := '[]'::JSONB;
  v_source_ids JSONB;
  v_fingerprint TEXT;
  v_observed_at TIMESTAMPTZ;
  v_result JSONB;
BEGIN
  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'job_id is required';
  END IF;
  IF v_bundle_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'bundle_hash must be lowercase SHA-256';
  END IF;
  IF jsonb_typeof(v_bundle) <> 'object' THEN
    RAISE EXCEPTION 'bundle must be an object';
  END IF;

  SELECT
    rsa.run_id,
    rsa.scout_role,
    rsa.factory_job_id,
    rr.status AS research_status
  INTO v_assignment
  FROM public.research_scout_assignments AS rsa
  JOIN public.research_runs AS rr ON rr.id = rsa.run_id
  WHERE rsa.factory_job_id = v_job_id
  FOR UPDATE OF rsa, rr;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research Scout assignment not found for job %', v_job_id;
  END IF;
  IF v_assignment.research_status IN ('failed','cancelled') THEN
    RAISE EXCEPTION 'Cannot persist evidence into % research run', v_assignment.research_status;
  END IF;

  IF COALESCE(v_bundle->>'schema', '') <> 'research_scout_evidence_bundle'
    OR COALESCE((v_bundle->>'version')::INTEGER, 0) <> 1
  THEN
    RAISE EXCEPTION 'Invalid Scout evidence bundle schema/version';
  END IF;
  IF v_bundle->>'research_run_id' IS DISTINCT FROM v_assignment.run_id::TEXT THEN
    RAISE EXCEPTION 'Scout evidence bundle research_run_id mismatch';
  END IF;
  IF v_bundle->>'scout_role' IS DISTINCT FROM v_assignment.scout_role THEN
    RAISE EXCEPTION 'Scout evidence bundle role mismatch';
  END IF;
  IF jsonb_typeof(v_bundle->'sources') <> 'array'
    OR jsonb_typeof(v_bundle->'evidence') <> 'array'
  THEN
    RAISE EXCEPTION 'Scout evidence bundle sources/evidence must be arrays';
  END IF;
  IF jsonb_array_length(v_bundle->'sources') > 6 THEN
    RAISE EXCEPTION 'Scout source budget exceeded';
  END IF;
  IF jsonb_array_length(v_bundle->'evidence') > 10 THEN
    RAISE EXCEPTION 'Scout evidence budget exceeded';
  END IF;

  SELECT bundle_hash, result
  INTO v_existing
  FROM public.research_scout_evidence_commits
  WHERE run_id = v_assignment.run_id
    AND scout_role = v_assignment.scout_role
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.bundle_hash IS DISTINCT FROM v_bundle_hash THEN
      RAISE EXCEPTION 'Scout evidence was already committed with a different bundle hash';
    END IF;
    RETURN v_existing.result || jsonb_build_object('duplicate', true);
  END IF;

  FOR v_source IN
    SELECT item
    FROM jsonb_array_elements(v_bundle->'sources') AS source(item)
  LOOP
    v_source_ref := NULLIF(trim(v_source->>'source_ref'), '');
    IF v_source_ref IS NULL THEN
      RAISE EXCEPTION 'Every source requires source_ref';
    END IF;
    IF v_source_map ? v_source_ref THEN
      RAISE EXCEPTION 'Duplicate source_ref in Scout evidence bundle: %', v_source_ref;
    END IF;
    IF COALESCE(v_source->>'canonical_url', '') !~* '^https?://' THEN
      RAISE EXCEPTION 'Research source must use http/https';
    END IF;
    IF lower(COALESCE(v_source->>'url_hash', '')) !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Research source url_hash must be SHA-256';
    END IF;
    IF v_source ? 'content_hash'
      AND NULLIF(v_source->>'content_hash', '') IS NOT NULL
      AND lower(v_source->>'content_hash') !~ '^[0-9a-f]{64}$'
    THEN
      RAISE EXCEPTION 'Research source content_hash must be SHA-256 when present';
    END IF;
    IF v_source ? 'metadata'
      AND jsonb_typeof(v_source->'metadata') <> 'object'
    THEN
      RAISE EXCEPTION 'Research source metadata must be an object';
    END IF;

    v_observed_at := NULLIF(v_source->>'observed_at', '')::TIMESTAMPTZ;
    IF v_observed_at IS NULL THEN
      RAISE EXCEPTION 'Research source observed_at is required';
    END IF;

    INSERT INTO public.research_sources (
      canonical_url,
      url_hash,
      source_type,
      title,
      published_at,
      observed_at,
      fetched_at,
      content_hash,
      extracted_text,
      metadata
    )
    VALUES (
      v_source->>'canonical_url',
      lower(v_source->>'url_hash'),
      COALESCE(NULLIF(v_source->>'source_type', ''), 'web_page'),
      NULLIF(v_source->>'title', ''),
      NULLIF(v_source->>'published_at', '')::TIMESTAMPTZ,
      v_observed_at,
      NULLIF(v_source->>'fetched_at', '')::TIMESTAMPTZ,
      lower(NULLIF(v_source->>'content_hash', '')),
      NULLIF(v_source->>'extracted_text', ''),
      COALESCE(v_source->'metadata', '{}'::JSONB)
    )
    ON CONFLICT (url_hash) DO UPDATE
    SET
      canonical_url = EXCLUDED.canonical_url,
      title = COALESCE(EXCLUDED.title, research_sources.title),
      published_at = COALESCE(research_sources.published_at, EXCLUDED.published_at),
      observed_at = GREATEST(research_sources.observed_at, EXCLUDED.observed_at),
      fetched_at = GREATEST(research_sources.fetched_at, EXCLUDED.fetched_at),
      content_hash = CASE
        WHEN EXCLUDED.observed_at >= research_sources.observed_at
          THEN COALESCE(EXCLUDED.content_hash, research_sources.content_hash)
        ELSE research_sources.content_hash
      END,
      extracted_text = CASE
        WHEN EXCLUDED.observed_at >= research_sources.observed_at
          THEN COALESCE(EXCLUDED.extracted_text, research_sources.extracted_text)
        ELSE research_sources.extracted_text
      END,
      metadata = research_sources.metadata || EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id INTO v_source_id;

    INSERT INTO public.research_run_sources (
      run_id,
      source_id,
      scout_role,
      relevance_score,
      selected,
      reused_from_cache,
      metadata
    )
    VALUES (
      v_assignment.run_id,
      v_source_id,
      v_assignment.scout_role,
      NULLIF(v_source->>'relevance_score', '')::DOUBLE PRECISION,
      FALSE,
      COALESCE((v_source->>'reused_from_cache')::BOOLEAN, FALSE),
      jsonb_build_object('source_ref', v_source_ref)
    )
    ON CONFLICT (run_id, source_id, scout_role) DO UPDATE
    SET
      relevance_score = COALESCE(EXCLUDED.relevance_score, research_run_sources.relevance_score),
      reused_from_cache = research_run_sources.reused_from_cache OR EXCLUDED.reused_from_cache,
      metadata = research_run_sources.metadata || EXCLUDED.metadata;

    v_source_map := v_source_map || jsonb_build_object(v_source_ref, v_source_id::TEXT);
  END LOOP;

  FOR v_evidence IN
    SELECT item
    FROM jsonb_array_elements(v_bundle->'evidence') AS evidence(item)
  LOOP
    v_evidence_ref := NULLIF(trim(v_evidence->>'evidence_ref'), '');
    IF v_evidence_ref IS NULL THEN
      RAISE EXCEPTION 'Every evidence item requires evidence_ref';
    END IF;
    IF v_evidence_map ? v_evidence_ref THEN
      RAISE EXCEPTION 'Duplicate evidence_ref in Scout evidence bundle: %', v_evidence_ref;
    END IF;
    v_fingerprint := lower(COALESCE(v_evidence->>'evidence_fingerprint', ''));
    IF v_fingerprint !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Evidence fingerprint must be SHA-256';
    END IF;
    IF COALESCE(v_evidence->>'evidence_type', '') NOT IN (
      'market_pattern','mechanic_pattern','player_love','player_pain','saturation_signal',
      'white_space','counterexample','gameplay_reference_pattern','visual_reference_pattern'
    ) THEN
      RAISE EXCEPTION 'Invalid research evidence type';
    END IF;
    IF NULLIF(trim(v_evidence->>'subject'), '') IS NULL
      OR NULLIF(trim(v_evidence->>'claim'), '') IS NULL
    THEN
      RAISE EXCEPTION 'Evidence subject and claim are required';
    END IF;
    IF jsonb_typeof(v_evidence->'source_refs') <> 'array'
      OR jsonb_array_length(v_evidence->'source_refs') = 0
    THEN
      RAISE EXCEPTION 'Evidence requires at least one source_ref';
    END IF;
    IF COALESCE((v_evidence->>'confidence')::DOUBLE PRECISION, -1) < 0
      OR COALESCE((v_evidence->>'confidence')::DOUBLE PRECISION, 2) > 1
    THEN
      RAISE EXCEPTION 'Evidence confidence must be between 0 and 1';
    END IF;
    IF COALESCE(v_evidence->>'freshness_class', '') NOT IN ('fresh','recent','evergreen','unknown') THEN
      RAISE EXCEPTION 'Invalid evidence freshness_class';
    END IF;
    IF jsonb_typeof(COALESCE(v_evidence->'tags', '[]'::JSONB)) <> 'array' THEN
      RAISE EXCEPTION 'Evidence tags must be an array';
    END IF;
    IF jsonb_typeof(COALESCE(v_evidence->'metadata', '{}'::JSONB)) <> 'object' THEN
      RAISE EXCEPTION 'Evidence metadata must be an object';
    END IF;

    v_observed_at := NULLIF(v_evidence->>'observed_at', '')::TIMESTAMPTZ;
    IF v_observed_at IS NULL THEN
      RAISE EXCEPTION 'Evidence observed_at is required';
    END IF;

    -- Validate all source refs before the evidence row is inserted.
    FOR v_source_ref_text IN
      SELECT value
      FROM jsonb_array_elements_text(v_evidence->'source_refs') AS refs(value)
    LOOP
      IF NOT (v_source_map ? v_source_ref_text) THEN
        RAISE EXCEPTION 'Evidence references unknown source_ref: %', v_source_ref_text;
      END IF;
    END LOOP;

    v_evidence_id := NULL;
    INSERT INTO public.research_evidence (
      run_id,
      scout_role,
      evidence_type,
      subject,
      claim,
      confidence,
      freshness_class,
      tags,
      observed_at,
      metadata,
      evidence_fingerprint
    )
    VALUES (
      v_assignment.run_id,
      v_assignment.scout_role,
      v_evidence->>'evidence_type',
      v_evidence->>'subject',
      v_evidence->>'claim',
      (v_evidence->>'confidence')::DOUBLE PRECISION,
      v_evidence->>'freshness_class',
      COALESCE(v_evidence->'tags', '[]'::JSONB),
      v_observed_at,
      COALESCE(v_evidence->'metadata', '{}'::JSONB),
      v_fingerprint
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_evidence_id;

    IF v_evidence_id IS NULL THEN
      SELECT id
      INTO v_evidence_id
      FROM public.research_evidence
      WHERE run_id = v_assignment.run_id
        AND scout_role = v_assignment.scout_role
        AND evidence_fingerprint = v_fingerprint;
      IF v_evidence_id IS NULL THEN
        RAISE EXCEPTION 'Evidence dedupe conflict could not be reconciled';
      END IF;
    END IF;

    v_source_ids := '[]'::JSONB;
    FOR v_source_ref_text IN
      SELECT value
      FROM jsonb_array_elements_text(v_evidence->'source_refs') AS refs(value)
    LOOP
      v_source_id := (v_source_map->>v_source_ref_text)::UUID;
      INSERT INTO public.research_evidence_sources (evidence_id, source_id, support_kind)
      VALUES (v_evidence_id, v_source_id, 'support')
      ON CONFLICT (evidence_id, source_id) DO NOTHING;
      v_source_ids := v_source_ids || jsonb_build_array(v_source_id::TEXT);
    END LOOP;

    v_evidence_map := v_evidence_map || jsonb_build_object(v_evidence_ref, v_evidence_id::TEXT);
    v_final_evidence := v_final_evidence || jsonb_build_array(jsonb_build_object(
      'schema', 'research_evidence',
      'version', 1,
      'evidenceId', v_evidence_id::TEXT,
      'researchRunId', v_assignment.run_id::TEXT,
      'scoutRole', v_assignment.scout_role,
      'evidenceType', v_evidence->>'evidence_type',
      'subject', v_evidence->>'subject',
      'claim', v_evidence->>'claim',
      'sourceIds', v_source_ids,
      'confidence', (v_evidence->>'confidence')::DOUBLE PRECISION,
      'freshnessClass', v_evidence->>'freshness_class',
      'observedAt', v_observed_at,
      'tags', COALESCE(v_evidence->'tags', '[]'::JSONB),
      'metadata', COALESCE(v_evidence->'metadata', '{}'::JSONB)
    ));
  END LOOP;

  v_result := jsonb_build_object(
    'duplicate', false,
    'bundle_hash', v_bundle_hash,
    'source_ids_by_ref', v_source_map,
    'evidence_ids_by_ref', v_evidence_map,
    'evidence', v_final_evidence
  );

  INSERT INTO public.research_scout_evidence_commits (
    run_id,
    scout_role,
    bundle_hash,
    result
  )
  VALUES (
    v_assignment.run_id,
    v_assignment.scout_role,
    v_bundle_hash,
    v_result
  );

  UPDATE public.research_scout_assignments
  SET metadata = metadata || jsonb_build_object(
    'evidence_bundle_hash', v_bundle_hash,
    'source_count', jsonb_array_length(v_bundle->'sources'),
    'evidence_count', jsonb_array_length(v_bundle->'evidence'),
    'evidence_committed_at', NOW()
  )
  WHERE run_id = v_assignment.run_id
    AND scout_role = v_assignment.scout_role;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.research_persist_scout_evidence_bundle(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_persist_scout_evidence_bundle(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Compact synthesis input: typed Scout reports + atomic evidence only.
-- Full fetched source text deliberately does not cross this boundary.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.research_get_synthesis_input(p_research_run_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run RECORD;
  v_scout_statuses JSONB;
  v_evidence JSONB;
  v_known_source_ids JSONB;
  v_known_image_ids JSONB;
  v_active_pack JSONB;
BEGIN
  SELECT id, objective_id
  INTO v_run
  FROM public.research_runs
  WHERE id = p_research_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research run not found: %', p_research_run_id;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'scout_role', rsa.scout_role,
        'status', fj.status,
        'report', cr.outputs->'scout_report'
      ) ORDER BY rsa.scout_role
    ),
    '[]'::JSONB
  )
  INTO v_scout_statuses
  FROM public.research_scout_assignments AS rsa
  JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
  JOIN public.creative_runs AS cr ON cr.id = rsa.creative_run_id
  WHERE rsa.run_id = p_research_run_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'schema', 'research_evidence',
        'version', 1,
        'evidenceId', re.id::TEXT,
        'researchRunId', re.run_id::TEXT,
        'scoutRole', re.scout_role,
        'evidenceType', re.evidence_type,
        'subject', re.subject,
        'claim', re.claim,
        'sourceIds', COALESCE((
          SELECT jsonb_agg(res.source_id::TEXT ORDER BY res.source_id::TEXT)
          FROM public.research_evidence_sources AS res
          WHERE res.evidence_id = re.id
        ), '[]'::JSONB),
        'confidence', re.confidence,
        'freshnessClass', re.freshness_class,
        'observedAt', re.observed_at,
        'tags', re.tags,
        'metadata', re.metadata
      ) ORDER BY re.created_at, re.id
    ),
    '[]'::JSONB
  )
  INTO v_evidence
  FROM public.research_evidence AS re
  WHERE re.run_id = p_research_run_id;

  SELECT COALESCE(jsonb_agg(source_id::TEXT ORDER BY source_id::TEXT), '[]'::JSONB)
  INTO v_known_source_ids
  FROM (
    SELECT DISTINCT rrs.source_id
    FROM public.research_run_sources AS rrs
    WHERE rrs.run_id = p_research_run_id
  ) AS source_ids;

  SELECT COALESCE(jsonb_agg(id::TEXT ORDER BY id::TEXT), '[]'::JSONB)
  INTO v_known_image_ids
  FROM public.research_assets
  WHERE run_id = p_research_run_id
    AND status <> 'invalid';

  SELECT rp.pack
  INTO v_active_pack
  FROM public.research_packs AS rp
  WHERE rp.run_id = p_research_run_id
    AND rp.active = TRUE
  ORDER BY rp.generated_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'research_run_id', v_run.id::TEXT,
    'objective_id', v_run.objective_id,
    'scout_statuses', v_scout_statuses,
    'evidence', v_evidence,
    'known_source_ids', v_known_source_ids,
    'known_image_reference_ids', v_known_image_ids,
    'active_pack', v_active_pack
  );
END;
$$;

REVOKE ALL ON FUNCTION public.research_get_synthesis_input(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_get_synthesis_input(UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- EvidencePack persistence with DB-level orphan checks and provenance joins.
-- A persisted active pack is the restart-safe boundary: the model does not need to run again after
-- a worker/process crash once this transaction commits.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.research_persist_evidence_pack(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_research_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_input_hash TEXT := lower(COALESCE(payload->>'input_hash', ''));
  v_pack JSONB := COALESCE(payload->'pack', '{}'::JSONB);
  v_metadata JSONB := COALESCE(payload->'metadata', '{}'::JSONB);
  v_run RECORD;
  v_existing RECORD;
  v_pack_id UUID;
  v_refs JSONB := '[]'::JSONB;
  v_section TEXT;
  v_item JSONB;
  v_ordinal BIGINT;
  v_evidence_id UUID;
  v_source_id UUID;
BEGIN
  IF v_research_run_id IS NULL THEN
    RAISE EXCEPTION 'research_run_id is required';
  END IF;
  IF v_input_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'input_hash must be lowercase SHA-256';
  END IF;
  IF jsonb_typeof(v_pack) <> 'object' THEN
    RAISE EXCEPTION 'pack must be an object';
  END IF;
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'metadata must be an object';
  END IF;

  SELECT id, objective_id, status
  INTO v_run
  FROM public.research_runs
  WHERE id = v_research_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Research run not found: %', v_research_run_id;
  END IF;
  IF v_run.status IN ('failed','cancelled') THEN
    RAISE EXCEPTION 'Cannot persist Evidence Pack into % research run', v_run.status;
  END IF;

  IF COALESCE(v_pack->>'schema', '') <> 'evidence_pack'
    OR COALESCE((v_pack->>'version')::INTEGER, 0) <> 1
  THEN
    RAISE EXCEPTION 'Invalid Evidence Pack schema/version';
  END IF;
  IF v_pack->>'researchRunId' IS DISTINCT FROM v_research_run_id::TEXT THEN
    RAISE EXCEPTION 'Evidence Pack researchRunId mismatch';
  END IF;
  IF v_pack->>'objectiveId' IS DISTINCT FROM v_run.objective_id THEN
    RAISE EXCEPTION 'Evidence Pack objectiveId mismatch';
  END IF;
  IF v_pack ? 'concepts' OR v_pack ? 'candidates' OR v_pack ? 'gameConcepts' THEN
    RAISE EXCEPTION 'Research Synthesizer cannot persist final game concepts';
  END IF;
  IF jsonb_typeof(COALESCE(v_pack->'coverage', '{}'::JSONB)) <> 'object' THEN
    RAISE EXCEPTION 'Evidence Pack coverage must be an object';
  END IF;
  IF jsonb_typeof(COALESCE(v_pack->'contradictions', '[]'::JSONB)) <> 'array'
    OR jsonb_typeof(COALESCE(v_pack->'selectedSourceIds', '[]'::JSONB)) <> 'array'
    OR jsonb_typeof(COALESCE(v_pack->'selectedImageReferenceIds', '[]'::JSONB)) <> 'array'
  THEN
    RAISE EXCEPTION 'Evidence Pack contradiction/selection fields must be arrays';
  END IF;

  v_pack_id := NULLIF(v_pack->>'packId', '')::UUID;
  IF v_pack_id IS NULL THEN
    RAISE EXCEPTION 'Evidence Pack packId must be a UUID';
  END IF;

  SELECT id, pack
  INTO v_existing
  FROM public.research_packs
  WHERE run_id = v_research_run_id
    AND active = TRUE
    AND input_hash = v_input_hash
  ORDER BY generated_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'duplicate', true,
      'pack_id', v_existing.id::TEXT,
      'pack', v_existing.pack
    );
  END IF;

  FOREACH v_section IN ARRAY ARRAY[
    'marketLandscape','mechanicLandscape','playerPositiveSignals','playerPainSignals',
    'saturatedPatterns','whiteSpaces','counterexamples','gameplayReferencePatterns',
    'visualReferencePatterns'
  ]
  LOOP
    IF jsonb_typeof(COALESCE(v_pack->v_section, '[]'::JSONB)) <> 'array' THEN
      RAISE EXCEPTION 'Evidence Pack section % must be an array', v_section;
    END IF;
    v_refs := v_refs || COALESCE(v_pack->v_section, '[]'::JSONB);
  END LOOP;

  -- Every EvidenceRef must resolve to evidence from this exact research run.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_refs) AS ref(item)
    WHERE NULLIF(ref.item->>'evidenceId', '') IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.research_evidence AS re
        WHERE re.id = (ref.item->>'evidenceId')::UUID
          AND re.run_id = v_research_run_id
      )
  ) THEN
    RAISE EXCEPTION 'Evidence Pack contains orphan or cross-run evidence ID';
  END IF;

  -- Source IDs carried by an EvidenceRef must really support that exact evidence row.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_refs) AS ref(item)
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(ref.item->'sourceIds', '[]'::JSONB)) AS sid(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.research_evidence_sources AS res
      JOIN public.research_evidence AS re ON re.id = res.evidence_id
      WHERE res.evidence_id = (ref.item->>'evidenceId')::UUID
        AND res.source_id = sid.value::UUID
        AND re.run_id = v_research_run_id
    )
  ) THEN
    RAISE EXCEPTION 'Evidence Pack contains orphan source ID in EvidenceRef';
  END IF;

  -- Contradictions may point to multiple evidence rows, but every one must belong to the run.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_pack->'contradictions', '[]'::JSONB)) AS contradiction(item)
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(contradiction.item->'evidenceIds', '[]'::JSONB)) AS eid(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.research_evidence AS re
      WHERE re.id = eid.value::UUID
        AND re.run_id = v_research_run_id
    )
  ) THEN
    RAISE EXCEPTION 'Evidence Pack contradiction contains orphan evidence ID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(v_pack->'selectedSourceIds', '[]'::JSONB)) AS sid(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.research_run_sources AS rrs
      WHERE rrs.run_id = v_research_run_id
        AND rrs.source_id = sid.value::UUID
    )
  ) THEN
    RAISE EXCEPTION 'Evidence Pack selectedSourceIds contains orphan source ID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(COALESCE(v_pack->'selectedImageReferenceIds', '[]'::JSONB)) AS aid(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.research_assets AS ra
      WHERE ra.run_id = v_research_run_id
        AND ra.id = aid.value::UUID
        AND ra.status <> 'invalid'
    )
  ) THEN
    RAISE EXCEPTION 'Evidence Pack selectedImageReferenceIds contains orphan image ID';
  END IF;

  UPDATE public.research_packs
  SET active = FALSE
  WHERE run_id = v_research_run_id
    AND active = TRUE;

  INSERT INTO public.research_packs (
    id,
    run_id,
    schema_version,
    pack,
    input_hash,
    active,
    generated_at,
    metadata
  )
  VALUES (
    v_pack_id,
    v_research_run_id,
    1,
    v_pack,
    v_input_hash,
    TRUE,
    COALESCE(NULLIF(v_pack->>'generatedAt', '')::TIMESTAMPTZ, NOW()),
    v_metadata
  );

  FOREACH v_section IN ARRAY ARRAY[
    'marketLandscape','mechanicLandscape','playerPositiveSignals','playerPainSignals',
    'saturatedPatterns','whiteSpaces','counterexamples','gameplayReferencePatterns',
    'visualReferencePatterns'
  ]
  LOOP
    FOR v_item, v_ordinal IN
      SELECT item, ord
      FROM jsonb_array_elements(COALESCE(v_pack->v_section, '[]'::JSONB))
        WITH ORDINALITY AS items(item, ord)
    LOOP
      v_evidence_id := (v_item->>'evidenceId')::UUID;
      INSERT INTO public.research_pack_evidence(pack_id, evidence_id, section, ordinal)
      VALUES (v_pack_id, v_evidence_id, v_section, GREATEST(v_ordinal::INTEGER - 1, 0))
      ON CONFLICT (pack_id, evidence_id, section) DO NOTHING;
    END LOOP;
  END LOOP;

  FOR v_item, v_ordinal IN
    SELECT item, ord
    FROM jsonb_array_elements(COALESCE(v_pack->'contradictions', '[]'::JSONB))
      WITH ORDINALITY AS items(item, ord)
  LOOP
    FOR v_evidence_id IN
      SELECT value::UUID
      FROM jsonb_array_elements_text(COALESCE(v_item->'evidenceIds', '[]'::JSONB)) AS ids(value)
    LOOP
      INSERT INTO public.research_pack_evidence(pack_id, evidence_id, section, ordinal)
      VALUES (v_pack_id, v_evidence_id, 'contradictions', GREATEST(v_ordinal::INTEGER - 1, 0))
      ON CONFLICT (pack_id, evidence_id, section) DO NOTHING;
    END LOOP;
  END LOOP;

  FOR v_source_id IN
    SELECT value::UUID
    FROM jsonb_array_elements_text(COALESCE(v_pack->'selectedSourceIds', '[]'::JSONB)) AS ids(value)
  LOOP
    INSERT INTO public.research_pack_sources(pack_id, source_id)
    VALUES (v_pack_id, v_source_id)
    ON CONFLICT (pack_id, source_id) DO NOTHING;
  END LOOP;

  UPDATE public.research_run_sources AS rrs
  SET selected = TRUE
  WHERE rrs.run_id = v_research_run_id
    AND rrs.source_id IN (
      SELECT value::UUID
      FROM jsonb_array_elements_text(COALESCE(v_pack->'selectedSourceIds', '[]'::JSONB)) AS ids(value)
    );

  UPDATE public.research_runs
  SET
    status = 'completed',
    coverage = COALESCE(v_pack->'coverage', '{}'::JSONB),
    completed_at = COALESCE(completed_at, NOW()),
    updated_at = NOW()
  WHERE id = v_research_run_id;

  RETURN jsonb_build_object(
    'duplicate', false,
    'pack_id', v_pack_id::TEXT,
    'pack', v_pack
  );
END;
$$;

REVOKE ALL ON FUNCTION public.research_persist_evidence_pack(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_persist_evidence_pack(JSONB)
  TO service_role;
