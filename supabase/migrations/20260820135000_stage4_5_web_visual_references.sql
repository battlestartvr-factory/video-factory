-- Stage 4.5 PR6 — Web Visual References.
-- External web images remain Research Memory evidence. They are never generated assets and
-- never become Gameplay Reference Library rows without a future explicit promotion action.

CREATE TABLE IF NOT EXISTS public.research_image_reference_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL,
  moment_id TEXT,
  provider_model TEXT NOT NULL,
  provider_limit INTEGER NOT NULL CHECK (provider_limit BETWEEN 1 AND 8),
  set_hash TEXT NOT NULL,
  reference_set JSONB NOT NULL CHECK (jsonb_typeof(reference_set) = 'object'),
  compiled_lineage JSONB NOT NULL CHECK (jsonb_typeof(compiled_lineage) = 'object'),
  compiled_reference_assets JSONB NOT NULL CHECK (jsonb_typeof(compiled_reference_assets) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, set_hash)
);

CREATE INDEX IF NOT EXISTS idx_research_image_reference_sets_concept
  ON public.research_image_reference_sets(run_id, concept_id, created_at DESC);

ALTER TABLE public.research_image_reference_sets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.research_image_reference_sets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.research_image_reference_sets TO service_role;

COMMENT ON TABLE public.research_image_reference_sets IS
  'Stage 4.5 provider-bound reference selections and exact selected-reference lineage. External refs remain research_assets, not gameplay_references or generated assets.';

CREATE OR REPLACE FUNCTION public.research_register_visual_source(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_source JSONB := COALESCE(payload->'source', '{}'::JSONB);
  v_source_id UUID;
  v_canonical_url TEXT := NULLIF(v_source->>'canonical_url', '');
  v_url_hash TEXT := NULLIF(v_source->>'url_hash', '');
BEGIN
  IF v_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.research_runs WHERE id = v_run_id) THEN
    RAISE EXCEPTION 'research_visual_source_run_not_found';
  END IF;
  IF v_canonical_url IS NULL OR v_url_hash IS NULL OR v_canonical_url !~ '^https?://' THEN
    RAISE EXCEPTION 'research_visual_source_invalid';
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
  ) VALUES (
    v_canonical_url,
    v_url_hash,
    'web_page',
    NULLIF(v_source->>'title', ''),
    NULLIF(v_source->>'published_at', '')::TIMESTAMPTZ,
    COALESCE(NULLIF(v_source->>'observed_at', '')::TIMESTAMPTZ, NOW()),
    NULLIF(v_source->>'fetched_at', '')::TIMESTAMPTZ,
    NULLIF(v_source->>'content_hash', ''),
    NULLIF(v_source->>'extracted_text', ''),
    COALESCE(v_source->'metadata', '{}'::JSONB) || jsonb_build_object(
      'stage4_5_visual_source', TRUE,
      'untrusted_external_content', TRUE
    )
  )
  ON CONFLICT (url_hash) DO UPDATE SET
    observed_at = GREATEST(public.research_sources.observed_at, EXCLUDED.observed_at),
    fetched_at = COALESCE(EXCLUDED.fetched_at, public.research_sources.fetched_at),
    content_hash = COALESCE(EXCLUDED.content_hash, public.research_sources.content_hash),
    title = COALESCE(public.research_sources.title, EXCLUDED.title),
    metadata = public.research_sources.metadata || EXCLUDED.metadata
  RETURNING id INTO v_source_id;

  INSERT INTO public.research_run_sources (
    run_id,
    source_id,
    scout_role,
    relevance_score,
    selected,
    reused_from_cache,
    metadata
  ) VALUES (
    v_run_id,
    v_source_id,
    'gameplay_visual',
    1.0,
    TRUE,
    COALESCE((payload->>'reused_from_cache')::BOOLEAN, FALSE),
    jsonb_build_object(
      'visual_reference_query', COALESCE(payload->>'query', ''),
      'stage4_5_pr6', TRUE
    )
  )
  ON CONFLICT (run_id, source_id, scout_role) DO UPDATE SET
    selected = TRUE,
    relevance_score = GREATEST(COALESCE(public.research_run_sources.relevance_score, 0), 1.0),
    metadata = public.research_run_sources.metadata || EXCLUDED.metadata;

  RETURN jsonb_build_object('source_id', v_source_id::TEXT);
END;
$$;

CREATE OR REPLACE FUNCTION public.research_list_visual_fingerprints(p_research_run_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'items',
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'reference_id', id::TEXT,
          'content_sha256', sha256,
          'perceptual_hash', perceptual_hash
        ) ORDER BY created_at ASC
      ) FILTER (WHERE sha256 IS NOT NULL),
      '[]'::JSONB
    )
  )
  FROM public.research_assets
  WHERE run_id = p_research_run_id
    AND asset_type = 'image'
    AND status IN ('candidate','selected','archived');
$$;

CREATE OR REPLACE FUNCTION public.research_persist_external_visual_reference(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reference JSONB := COALESCE(payload->'reference', '{}'::JSONB);
  v_reference_id UUID := NULLIF(v_reference->>'referenceId', '')::UUID;
  v_run_id UUID := NULLIF(v_reference->>'researchRunId', '')::UUID;
  v_source_id UUID := NULLIF(v_reference->>'sourceId', '')::UUID;
  v_roles JSONB := COALESCE(v_reference->'roles', '[]'::JSONB);
  v_metadata JSONB := COALESCE(v_reference->'metadata', '{}'::JSONB);
  v_existing_run UUID;
  v_existing_sha TEXT;
BEGIN
  IF v_reference->>'schema' <> 'external_visual_reference'
     OR (v_reference->>'version')::INTEGER <> 1
     OR v_reference_id IS NULL
     OR v_run_id IS NULL
     OR v_source_id IS NULL THEN
    RAISE EXCEPTION 'external_visual_reference_schema_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.research_runs WHERE id = v_run_id) THEN
    RAISE EXCEPTION 'external_visual_reference_run_not_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.research_run_sources
    WHERE run_id = v_run_id AND source_id = v_source_id
  ) THEN
    RAISE EXCEPTION 'external_visual_reference_source_not_linked';
  END IF;
  IF NULLIF(v_reference->>'driveFileId', '') IS NULL THEN
    RAISE EXCEPTION 'external_visual_reference_archive_required';
  END IF;
  IF COALESCE(v_reference->>'contentSha256', '') !~ '^[a-fA-F0-9]{64}$' THEN
    RAISE EXCEPTION 'external_visual_reference_sha_invalid';
  END IF;
  IF jsonb_typeof(v_roles) <> 'array' OR jsonb_array_length(v_roles) < 1 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(v_roles) role
    WHERE role NOT IN (
      'gameplay_grammar','environment_object','composition',
      'art_direction','ui_affordance','negative_reference'
    )
  ) THEN
    RAISE EXCEPTION 'external_visual_reference_roles_invalid';
  END IF;
  IF COALESCE((v_metadata->>'generated_asset')::BOOLEAN, FALSE) = TRUE
     OR COALESCE((v_metadata->>'gameplay_library_entry')::BOOLEAN, FALSE) = TRUE THEN
    RAISE EXCEPTION 'external_visual_reference_classification_invalid';
  END IF;

  SELECT run_id, sha256 INTO v_existing_run, v_existing_sha
  FROM public.research_assets
  WHERE id = v_reference_id;
  IF FOUND THEN
    IF v_existing_run <> v_run_id OR lower(COALESCE(v_existing_sha, '')) <> lower(v_reference->>'contentSha256') THEN
      RAISE EXCEPTION 'external_visual_reference_id_conflict';
    END IF;
    RETURN jsonb_build_object('persisted', TRUE, 'duplicate', TRUE, 'reference', v_reference);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.research_assets
    WHERE run_id = v_run_id
      AND sha256 IS NOT NULL
      AND lower(sha256) = lower(v_reference->>'contentSha256')
  ) THEN
    RAISE EXCEPTION 'external_visual_reference_exact_duplicate';
  END IF;

  INSERT INTO public.research_assets (
    id,
    run_id,
    source_id,
    asset_type,
    original_url,
    drive_file_id,
    mime,
    width,
    height,
    sha256,
    perceptual_hash,
    roles,
    why_relevant,
    must_not_copy,
    trust,
    status,
    observed_at,
    metadata
  ) VALUES (
    v_reference_id,
    v_run_id,
    v_source_id,
    'image',
    v_reference->>'imageUrl',
    v_reference->>'driveFileId',
    v_reference->>'mimeType',
    (v_reference->>'width')::INTEGER,
    (v_reference->>'height')::INTEGER,
    lower(v_reference->>'contentSha256'),
    NULLIF(v_reference->>'perceptualHash', ''),
    v_roles,
    NULLIF(v_reference->>'whyRelevant', ''),
    COALESCE(v_reference->'mustNotCopy', '[]'::JSONB),
    COALESCE(NULLIF(v_reference->>'trust', ''), 'normal'),
    'archived',
    (v_reference->>'observedAt')::TIMESTAMPTZ,
    v_metadata || jsonb_build_object(
      'external_reference', TRUE,
      'generated_asset', FALSE,
      'gameplay_library_entry', FALSE,
      'stage4_5_pr6', TRUE
    )
  );

  RETURN jsonb_build_object('persisted', TRUE, 'duplicate', FALSE, 'reference', v_reference);
END;
$$;

CREATE OR REPLACE FUNCTION public.research_persist_image_reference_set(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set JSONB := COALESCE(payload->'reference_set', '{}'::JSONB);
  v_lineage JSONB := COALESCE(payload->'compiled_lineage', '{}'::JSONB);
  v_assets JSONB := COALESCE(payload->'reference_assets', '[]'::JSONB);
  v_run_id UUID := NULLIF(v_set->>'researchRunId', '')::UUID;
  v_concept_id TEXT := NULLIF(v_set->>'conceptId', '');
  v_moment_id TEXT := NULLIF(v_set->>'momentId', '');
  v_provider_model TEXT := NULLIF(payload->>'provider_model', '');
  v_provider_limit INTEGER := COALESCE((payload->>'provider_limit')::INTEGER, 0);
  v_set_hash TEXT := NULLIF(payload->>'set_hash', '');
  v_reference JSONB;
  v_id UUID;
BEGIN
  IF v_set->>'schema' <> 'image_reference_set'
     OR (v_set->>'version')::INTEGER <> 1
     OR v_run_id IS NULL
     OR v_concept_id IS NULL
     OR v_provider_model IS NULL
     OR v_set_hash IS NULL THEN
    RAISE EXCEPTION 'image_reference_set_schema_invalid';
  END IF;
  IF jsonb_typeof(v_set->'references') <> 'array'
     OR jsonb_array_length(v_set->'references') < 1
     OR jsonb_array_length(v_set->'references') > v_provider_limit
     OR v_provider_limit NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'image_reference_set_provider_limit_invalid';
  END IF;
  IF jsonb_typeof(v_assets) <> 'array' OR jsonb_array_length(v_assets) <> jsonb_array_length(v_set->'references') THEN
    RAISE EXCEPTION 'image_reference_set_materialization_invalid';
  END IF;

  FOR v_reference IN SELECT value FROM jsonb_array_elements(v_set->'references')
  LOOP
    IF v_reference->>'origin' = 'external_research' THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.research_assets ra
        WHERE ra.id = (v_reference->>'referenceId')::UUID
          AND ra.run_id = v_run_id
          AND ra.asset_type = 'image'
          AND ra.status IN ('selected','archived')
          AND ra.drive_file_id IS NOT NULL
          AND COALESCE((ra.metadata->>'generated_asset')::BOOLEAN, FALSE) = FALSE
          AND COALESCE((ra.metadata->>'gameplay_library_entry')::BOOLEAN, FALSE) = FALSE
      ) THEN
        RAISE EXCEPTION 'image_reference_set_external_lineage_invalid:%', v_reference->>'referenceId';
      END IF;
    ELSIF v_reference->>'origin' <> 'gameplay_library' THEN
      RAISE EXCEPTION 'image_reference_set_origin_invalid';
    END IF;
  END LOOP;

  INSERT INTO public.research_image_reference_sets (
    run_id,
    concept_id,
    moment_id,
    provider_model,
    provider_limit,
    set_hash,
    reference_set,
    compiled_lineage,
    compiled_reference_assets
  ) VALUES (
    v_run_id,
    v_concept_id,
    v_moment_id,
    v_provider_model,
    v_provider_limit,
    v_set_hash,
    v_set,
    v_lineage,
    v_assets
  )
  ON CONFLICT (run_id, set_hash) DO UPDATE SET
    compiled_lineage = EXCLUDED.compiled_lineage,
    compiled_reference_assets = EXCLUDED.compiled_reference_assets
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('persisted', TRUE, 'reference_set_id', v_id::TEXT, 'set_hash', v_set_hash);
END;
$$;

REVOKE ALL ON FUNCTION public.research_register_visual_source(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_list_visual_fingerprints(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_persist_external_visual_reference(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_persist_image_reference_set(JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.research_register_visual_source(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.research_list_visual_fingerprints(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.research_persist_external_visual_reference(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.research_persist_image_reference_set(JSONB) TO service_role;
