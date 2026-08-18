-- Stage 4 / S4-005: a human review is an external event and must wake the parked root workflow.
-- The review insert and PGMQ wake-up are committed atomically so APPROVE/REVISE/REJECT cannot leave the batch stranded.

CREATE OR REPLACE FUNCTION public.orchestrator_record_gameplay_reference_review(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_root_run_id UUID := NULLIF(payload->>'root_creative_run_id', '')::UUID;
  v_concept_run_id UUID := NULLIF(payload->>'concept_run_id', '')::UUID;
  v_generation_id UUID := NULLIF(payload->>'generation_id', '')::UUID;
  v_user_id UUID := NULLIF(payload->>'user_id', '')::UUID;
  v_decision TEXT := NULLIF(trim(payload->>'decision'), '');
  v_structured JSONB := COALESCE(payload->'structured_feedback', '{}'::JSONB);
  v_review public.gameplay_reference_reviews%ROWTYPE;
  v_root public.creative_runs%ROWTYPE;
  v_job public.factory_jobs%ROWTYPE;
  v_msg_id BIGINT;
  v_trace_id UUID := gen_random_uuid();
BEGIN
  IF v_root_run_id IS NULL OR v_concept_run_id IS NULL OR v_decision IS NULL THEN
    RAISE EXCEPTION 'root_creative_run_id, concept_run_id and decision are required';
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.creative_runs cr
    WHERE cr.id = v_concept_run_id
      AND cr.parent_run_id = v_root_run_id
      AND cr.metadata->>'domain_kind' = 'coop_game_concept'
  ) THEN
    RAISE EXCEPTION 'concept run is not a child of discovery root';
  END IF;

  INSERT INTO public.gameplay_reference_reviews (
    root_creative_run_id, concept_run_id, generation_id, user_id,
    concept_id, moment_id, shot_id, decision, raw_feedback,
    structured_feedback, error_tags, must_show, must_avoid, reusable_scope, model, usage
  )
  VALUES (
    v_root_run_id, v_concept_run_id, v_generation_id, v_user_id,
    NULLIF(trim(payload->>'concept_id'), ''), NULLIF(trim(payload->>'moment_id'), ''),
    NULLIF(trim(payload->>'shot_id'), ''), v_decision, NULLIF(payload->>'raw_feedback', ''),
    v_structured, COALESCE(v_structured->'errorTags', '[]'::JSONB),
    COALESCE(v_structured->'mustShow', '[]'::JSONB), COALESCE(v_structured->'mustAvoid', '[]'::JSONB),
    COALESCE(NULLIF(v_structured->>'reusableScope', ''), 'concept'),
    NULLIF(trim(payload->>'model'), ''), COALESCE(payload->'usage', '{}'::JSONB)
  )
  RETURNING * INTO v_review;

  SELECT * INTO v_job
  FROM public.factory_jobs
  WHERE id = v_root.factory_job_id;

  IF FOUND AND v_job.status NOT IN ('completed', 'failed', 'cancelled') THEN
    SELECT msg_id INTO v_msg_id
    FROM pgmq.send(
      'core_orchestrator_v1',
      jsonb_build_object(
        'v', 1,
        'job_id', v_job.id,
        'reason', 'gameplay_reference_review_recorded',
        'trace_id', v_trace_id
      ),
      0
    ) AS msg_id;

    UPDATE public.factory_jobs
    SET last_enqueued_at = NOW()
    WHERE id = v_job.id;

    INSERT INTO public.factory_workflow_events (
      job_id, event_type, dedupe_key, payload, creative_run_id
    )
    VALUES (
      v_job.id,
      'job.enqueued',
      'stage4:reference-review:wakeup:' || v_review.id::TEXT,
      jsonb_build_object(
        'queue', 'core_orchestrator_v1',
        'queue_msg_id', v_msg_id,
        'reason', 'gameplay_reference_review_recorded',
        'review_id', v_review.id,
        'generation_id', v_generation_id,
        'decision', v_decision,
        'trace_id', v_trace_id
      ),
      v_root_run_id
    )
    ON CONFLICT (job_id, dedupe_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'review', to_jsonb(v_review),
    'queue_msg_id', v_msg_id,
    'trace_id', v_trace_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_record_gameplay_reference_review(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_record_gameplay_reference_review(JSONB)
  TO service_role;
