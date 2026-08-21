-- game_discovery_batch@2 parks the Human Concept Gate as awaiting_approval,
-- while orchestrator_claim_job intentionally claims only queued/waiting/retrying/running.
-- Persisting a valid human concept decision must make the root job claimable again
-- before publishing the normal durable wake-up.

CREATE OR REPLACE FUNCTION public.orchestrator_record_gameplay_concept_review(payload jsonb)
RETURNS jsonb
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
  WHERE id = v_root.factory_job_id
  FOR UPDATE;
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

  UPDATE public.factory_jobs
  SET status = CASE WHEN status = 'awaiting_approval' THEN 'queued' ELSE status END,
      next_action_at = CASE WHEN status = 'awaiting_approval' THEN NOW() ELSE next_action_at END,
      state_reason = CASE
        WHEN status = 'awaiting_approval' THEN 'human_concept_review_recorded'
        ELSE state_reason
      END,
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

UPDATE public.deployment_schema_contract
SET schema_version = '20260821124048',
    updated_at = NOW()
WHERE singleton = TRUE;
