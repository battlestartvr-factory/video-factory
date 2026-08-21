-- Keep human feedback in the user's original language for UI/audit, while handing
-- canonical English to the legacy Stage 4 regeneration worker through its existing
-- rawFeedback compatibility field. Also expose both forms explicitly for newer callers.
CREATE OR REPLACE FUNCTION public.orchestrator_get_game_discovery_concept_stage(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_root public.creative_runs%ROWTYPE;
  v_concept_runs JSONB;
  v_human_reviews JSONB;
BEGIN
  IF v_root_run_id IS NULL THEN
    RAISE EXCEPTION 'root_creative_run_id is required';
  END IF;

  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id
    AND metadata->>'domain_kind' = 'game_discovery_batch';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'game discovery root creative run not found';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'run_id', cr.id,
        'concept_id', cr.metadata->>'concept_id'
      )
      ORDER BY cr.created_at ASC
    ),
    '[]'::JSONB
  )
  INTO v_concept_runs
  FROM public.creative_runs cr
  WHERE cr.parent_run_id = v_root_run_id
    AND cr.metadata->>'domain_kind' = 'coop_game_concept';

  SELECT COALESCE(
    jsonb_object_agg(
      cr.id::TEXT,
      jsonb_build_object(
        'reviewId', review.id,
        'conceptRunId', cr.id,
        'conceptId', cr.metadata->>'concept_id',
        'decision', review.decision,
        -- Legacy worker field: prefer bounded canonical English when available.
        'rawFeedback', COALESCE(
          NULLIF(trim(review.structured_feedback->>'canonicalEnglish'), ''),
          review.raw_feedback
        ),
        -- Explicit fields for UI/newer orchestration code.
        'originalRawFeedback', review.raw_feedback,
        'structuredFeedback', COALESCE(review.structured_feedback, '{}'::JSONB),
        'createdAt', review.created_at
      )
    ) FILTER (WHERE review.id IS NOT NULL),
    '{}'::JSONB
  )
  INTO v_human_reviews
  FROM public.creative_runs cr
  LEFT JOIN LATERAL (
    SELECT r.*
    FROM public.gameplay_concept_reviews r
    WHERE r.root_creative_run_id = v_root_run_id
      AND r.concept_run_id = cr.id
    ORDER BY r.created_at DESC
    LIMIT 1
  ) review ON TRUE
  WHERE cr.parent_run_id = v_root_run_id
    AND cr.metadata->>'domain_kind' = 'coop_game_concept'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(v_root.outputs->'discovery_concepts', '[]'::JSONB)) AS active(value)
      WHERE active.value->>'conceptId' = cr.metadata->>'concept_id'
    );

  RETURN jsonb_build_object(
    'persisted', jsonb_typeof(v_root.outputs->'discovery_concepts') = 'array'
      AND jsonb_array_length(v_root.outputs->'discovery_concepts') > 0,
    'accepted_concepts', COALESCE(v_root.outputs->'discovery_concepts', '[]'::JSONB),
    'diversity_rejections', COALESCE(v_root.outputs->'diversity_rejections', '[]'::JSONB),
    'concept_explorer', COALESCE(v_root.outputs->'concept_explorer', '{}'::JSONB)
      || jsonb_build_object('human_reviews', v_human_reviews),
    'concept_runs', v_concept_runs
  );
END;
$function$;

UPDATE public.deployment_schema_contract
SET schema_version = '20260821162600',
    updated_at = NOW()
WHERE singleton = TRUE;