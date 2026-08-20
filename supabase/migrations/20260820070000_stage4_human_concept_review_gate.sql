-- Stage 4.1: Human Concept Approval Gate.
-- Concepts are now explicitly approved before pre-evaluation / gameplay planning.
-- Reject is retained as negative evidence, but the rejected concept is removed from
-- the active discovery_concepts set by the worker and replaced with a new concept.

CREATE TABLE IF NOT EXISTS public.gameplay_concept_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_creative_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  concept_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  concept_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','revise')),
  raw_feedback TEXT,
  structured_feedback JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gameplay_concept_reviews_root_created
  ON public.gameplay_concept_reviews(root_creative_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gameplay_concept_reviews_concept_created
  ON public.gameplay_concept_reviews(concept_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gameplay_concept_reviews_run_user
  ON public.gameplay_concept_reviews(concept_run_id, user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.gameplay_concept_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gameplay_concept_reviews FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.gameplay_concept_reviews TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_record_gameplay_concept_review(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_concept_run_id UUID := NULLIF(payload->>'concept_run_id', '')::UUID;
  v_user_id UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_concept_id TEXT := NULLIF(trim(payload->>'concept_id'), '');
  v_decision TEXT := NULLIF(trim(payload->>'decision'), '');
  v_feedback TEXT := NULLIF(trim(payload->>'raw_feedback'), '');
  v_structured JSONB := COALESCE(payload->'structured_feedback', '{}'::JSONB);
  v_review public.gameplay_concept_reviews%ROWTYPE;
  v_root public.creative_runs%ROWTYPE;
  v_concept public.creative_runs%ROWTYPE;
  v_job public.factory_jobs%ROWTYPE;
  v_current_reviews JSONB;
  v_review_state JSONB;
  v_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
BEGIN
  IF v_root_run_id IS NULL OR v_concept_run_id IS NULL OR v_user_id IS NULL
     OR v_concept_id IS NULL OR v_decision IS NULL THEN
    RAISE EXCEPTION 'root_creative_run_id, concept_run_id, user_id, concept_id and decision are required';
  END IF;
  IF v_decision NOT IN ('approve','reject','revise') THEN
    RAISE EXCEPTION 'invalid concept review decision';
  END IF;
  IF v_decision IN ('reject','revise') AND v_feedback IS NULL THEN
    RAISE EXCEPTION 'feedback is required for concept revise/reject';
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
  IF NOT FOUND OR v_job.status IN ('completed','failed','cancelled') THEN
    RAISE EXCEPTION 'game discovery job is not reviewable';
  END IF;
  IF v_job.current_stage IS DISTINCT FROM 'human_concept_approval_pending' THEN
    RAISE EXCEPTION 'concept review is allowed only at the active human concept approval gate';
  END IF;

  SELECT * INTO v_concept
  FROM public.creative_runs
  WHERE id = v_concept_run_id
    AND parent_run_id = v_root_run_id
    AND metadata->>'domain_kind' = 'coop_game_concept'
    AND metadata->>'concept_id' = v_concept_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'concept run is not a child of discovery root or concept id mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_root.outputs->'discovery_concepts', '[]'::JSONB)) AS active(value)
    WHERE active.value->>'conceptId' = v_concept_id
  ) THEN
    RAISE EXCEPTION 'concept is no longer active in this discovery batch';
  END IF;

  INSERT INTO public.gameplay_concept_reviews (
    root_creative_run_id,
    concept_run_id,
    user_id,
    concept_id,
    decision,
    raw_feedback,
    structured_feedback
  )
  VALUES (
    v_root_run_id,
    v_concept_run_id,
    v_user_id,
    v_concept_id,
    v_decision,
    v_feedback,
    v_structured
  )
  ON CONFLICT (concept_run_id, user_id)
    WHERE user_id IS NOT NULL
  DO UPDATE SET
    concept_id = EXCLUDED.concept_id,
    decision = EXCLUDED.decision,
    raw_feedback = EXCLUDED.raw_feedback,
    structured_feedback = EXCLUDED.structured_feedback,
    created_at = NOW()
  RETURNING * INTO v_review;

  v_current_reviews := COALESCE(v_job.state->'concept_reviews', '{}'::JSONB);
  IF jsonb_typeof(v_current_reviews) IS DISTINCT FROM 'object' THEN
    v_current_reviews := '{}'::JSONB;
  END IF;
  v_review_state := jsonb_build_object(
    'reviewId', v_review.id,
    'conceptRunId', v_concept_run_id,
    'conceptId', v_concept_id,
    'decision', v_decision,
    'rawFeedback', v_feedback,
    'createdAt', v_review.created_at
  );

  UPDATE public.factory_jobs
  SET
    state = jsonb_set(
      COALESCE(state, '{}'::JSONB),
      '{concept_reviews}',
      v_current_reviews || jsonb_build_object(v_concept_run_id::TEXT, v_review_state),
      true
    ),
    last_enqueued_at = NOW()
  WHERE id = v_job.id;

  SELECT msg_id INTO v_msg_id
  FROM pgmq.send(
    'core_orchestrator_v1',
    jsonb_build_object(
      'v', 1,
      'job_id', v_job.id,
      'reason', 'gameplay_concept_review_recorded',
      'trace_id', v_trace_id
    ),
    0
  ) AS msg_id;

  INSERT INTO public.factory_workflow_events (
    job_id,
    event_type,
    dedupe_key,
    payload,
    creative_run_id
  )
  VALUES (
    v_job.id,
    'job.enqueued',
    'stage4:concept-review:wakeup:' || v_trace_id::TEXT,
    jsonb_build_object(
      'queue', 'core_orchestrator_v1',
      'queue_msg_id', v_msg_id,
      'reason', 'gameplay_concept_review_recorded',
      'review_id', v_review.id,
      'concept_run_id', v_concept_run_id,
      'concept_id', v_concept_id,
      'decision', v_decision,
      'trace_id', v_trace_id
    ),
    v_root_run_id
  );

  RETURN jsonb_build_object(
    'review', to_jsonb(v_review),
    'queue_msg_id', v_msg_id,
    'trace_id', v_trace_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.orchestrator_record_gameplay_concept_review(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_gameplay_concept_review(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.orchestrator_get_gameplay_concept_approval_stage(payload JSONB)
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

  SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::JSONB)
  INTO v_items
  FROM (
    SELECT
      active.ordinal,
      jsonb_build_object(
        'concept', active.value,
        'concept_id', active.value->>'conceptId',
        'concept_run_id', cr.id,
        'decision', review.decision,
        'review_id', review.id,
        'raw_feedback', review.raw_feedback,
        'structured_feedback', COALESCE(review.structured_feedback, '{}'::JSONB)
      ) AS item
    FROM jsonb_array_elements(COALESCE(v_root.outputs->'discovery_concepts', '[]'::JSONB))
      WITH ORDINALITY AS active(value, ordinal)
    LEFT JOIN public.creative_runs cr
      ON cr.parent_run_id = v_root_run_id
      AND cr.metadata->>'domain_kind' = 'coop_game_concept'
      AND cr.metadata->>'concept_id' = active.value->>'conceptId'
    LEFT JOIN LATERAL (
      SELECT r.*
      FROM public.gameplay_concept_reviews r
      WHERE r.root_creative_run_id = v_root_run_id
        AND r.concept_run_id = cr.id
      ORDER BY r.created_at DESC
      LIMIT 1
    ) review ON TRUE
  ) rows;

  RETURN jsonb_build_object(
    'items', v_items,
    'concept_count', jsonb_array_length(v_items),
    'all_reviewed', jsonb_array_length(v_items) > 0 AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_items) AS item(value)
      WHERE item.value->>'decision' IS NULL
    ),
    'all_approved', jsonb_array_length(v_items) > 0 AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_items) AS item(value)
      WHERE item.value->>'decision' IS DISTINCT FROM 'approve'
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.orchestrator_get_gameplay_concept_approval_stage(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_gameplay_concept_approval_stage(JSONB)
  TO service_role;
