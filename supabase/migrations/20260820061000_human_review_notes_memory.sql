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
  SELECT * INTO v_root
  FROM public.creative_runs
  WHERE id = v_root_run_id AND metadata->>'domain_kind' = 'game_discovery_batch';
  IF NOT FOUND THEN RAISE EXCEPTION 'game discovery root creative run not found'; END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY created_at ASC), '[]'::JSONB)
  INTO v_items
  FROM (
    SELECT created_at, item
    FROM (
      SELECT r.created_at,
        jsonb_build_object(
          'id', r.id,
          'media_kind', 'reference_image',
          'concept_id', r.concept_id,
          'moment_id', r.moment_id,
          'shot_id', r.shot_id,
          'decision', r.decision,
          'review_note', CASE WHEN r.raw_feedback IS NULL THEN NULL ELSE
            '[reference_image][' || r.decision || '][concept=' || r.concept_id || '][shot=' || r.shot_id || '] ' ||
            left(COALESCE(NULLIF(r.structured_feedback->>'summary',''), r.raw_feedback), 700)
          END,
          'structured_feedback', r.structured_feedback,
          'error_tags', r.error_tags,
          'must_show', r.must_show,
          'must_avoid', r.must_avoid,
          'reusable_scope', r.reusable_scope
        ) AS item
      FROM public.gameplay_reference_reviews r
      JOIN public.creative_runs review_root ON review_root.id = r.root_creative_run_id
      WHERE r.root_creative_run_id = v_root_run_id
         OR (r.reusable_scope = 'project' AND v_root.project_id IS NOT NULL AND review_root.project_id = v_root.project_id)

      UNION ALL

      SELECT r.created_at,
        jsonb_build_object(
          'id', r.id,
          'media_kind', 'video',
          'concept_id', r.concept_id,
          'moment_id', r.moment_id,
          'shot_id', r.shot_id,
          'decision', r.decision,
          'review_note', CASE WHEN r.raw_feedback IS NULL THEN NULL ELSE
            '[video][' || r.decision || '][concept=' || r.concept_id || '][shot=' || r.shot_id || '] ' ||
            left(COALESCE(NULLIF(r.structured_feedback->>'summary',''), r.raw_feedback), 700)
          END,
          'structured_feedback', r.structured_feedback,
          'error_tags', r.error_tags,
          'must_show', r.must_show,
          'must_avoid', r.must_avoid,
          'reusable_scope', r.reusable_scope
        ) AS item
      FROM public.gameplay_video_reviews r
      JOIN public.creative_runs review_root ON review_root.id = r.root_creative_run_id
      WHERE r.root_creative_run_id = v_root_run_id
         OR (r.reusable_scope = 'project' AND v_root.project_id IS NOT NULL AND review_root.project_id = v_root.project_id)
    ) combined
    ORDER BY created_at DESC
    LIMIT 100
  ) rows;

  RETURN jsonb_build_object('items', v_items);
END;
$function$;
