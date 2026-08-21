-- PGMQ msg_id is unique only inside a queue. factory_workflow_events.dedupe_key
-- is globally unique, so research fan-out must include the queue name in the key.
CREATE OR REPLACE FUNCTION public.research_director_fanout(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pgmq'
AS $function$
DECLARE
  v_research_run_id UUID := NULLIF(payload->>'research_run_id', '')::UUID;
  v_plan JSONB := COALESCE(payload->'plan', '{}'::JSONB);
  v_assignments JSONB;
  v_research RECORD;
  v_root_job RECORD;
  v_assignment JSONB;
  v_role TEXT;
  v_child_job_id UUID;
  v_child_creative_run_id UUID;
  v_request_id UUID;
  v_msg_id BIGINT;
  v_trace_id UUID;
  v_existing RECORD;
  v_items JSONB := '[]'::JSONB;
  v_count INTEGER;
  v_distinct_count INTEGER;
BEGIN
  IF v_research_run_id IS NULL THEN
    RAISE EXCEPTION 'research_run_id is required';
  END IF;
  IF jsonb_typeof(v_plan) <> 'object' THEN
    RAISE EXCEPTION 'plan must be an object';
  END IF;

  v_assignments := v_plan->'scoutAssignments';
  IF jsonb_typeof(v_assignments) <> 'array' THEN
    RAISE EXCEPTION 'plan.scoutAssignments must be an array';
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT item->>'role')
  INTO v_count, v_distinct_count
  FROM jsonb_array_elements(v_assignments) AS item;

  IF v_count <> 5 OR v_distinct_count <> 5 THEN
    RAISE EXCEPTION 'Stage 4.5 v1 requires exactly five unique Scout roles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_assignments) AS item
    WHERE jsonb_typeof(item) <> 'object'
      OR COALESCE(item->>'role', '') NOT IN (
        'market_competitor','mechanics','player_voice','gameplay_visual','white_space_contrarian'
      )
  ) THEN
    RAISE EXCEPTION 'plan contains an invalid Scout assignment or role';
  END IF;

  IF EXISTS (
    SELECT required_role
    FROM unnest(ARRAY[
      'market_competitor','mechanics','player_voice','gameplay_visual','white_space_contrarian'
    ]) AS required_role
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_assignments) AS item
      WHERE item->>'role' = required_role
    )
  ) THEN
    RAISE EXCEPTION 'plan is missing one or more canonical Scout roles';
  END IF;

  SELECT rr.id, rr.factory_job_id, rr.root_creative_run_id, rr.objective_id, rr.status
  INTO v_research
  FROM public.research_runs AS rr
  WHERE rr.id = v_research_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'research run not found: %', v_research_run_id;
  END IF;
  IF v_research.status IN ('completed','failed','cancelled') THEN
    RAISE EXCEPTION 'cannot fan out terminal research run % with status %', v_research_run_id, v_research.status;
  END IF;

  SELECT fj.id, fj.user_id, fj.project_id
  INTO v_root_job
  FROM public.factory_jobs AS fj
  WHERE fj.id = v_research.factory_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'root factory job not found for research run %', v_research_run_id;
  END IF;

  FOR v_assignment IN
    SELECT item
    FROM jsonb_array_elements(v_assignments) WITH ORDINALITY AS assignment(item, ord)
    ORDER BY ord
  LOOP
    v_role := v_assignment->>'role';

    SELECT rsa.factory_job_id, rsa.creative_run_id
    INTO v_existing
    FROM public.research_scout_assignments AS rsa
    WHERE rsa.run_id = v_research_run_id
      AND rsa.scout_role = v_role;

    IF FOUND THEN
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'scout_role', v_role,
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
      id,
      request_id,
      project_id,
      user_id,
      workflow_kind,
      workflow_version,
      status,
      current_stage,
      input,
      state,
      next_action_at
    ) VALUES (
      v_child_job_id,
      v_request_id,
      v_root_job.project_id,
      v_root_job.user_id,
      'external_research_scout',
      1,
      'queued',
      'research_scout_assigned',
      jsonb_build_object(
        'research_run_id', v_research_run_id,
        'root_factory_job_id', v_research.factory_job_id,
        'root_creative_run_id', v_research.root_creative_run_id,
        'objective_id', v_research.objective_id,
        'assignment', v_assignment
      ),
      jsonb_build_object(
        'research_run_id', v_research_run_id,
        'scout_role', v_role,
        'phase', 'assigned'
      ),
      NOW()
    );

    INSERT INTO public.creative_runs (
      id,
      user_id,
      project_id,
      parent_run_id,
      factory_job_id,
      run_type,
      status,
      title,
      objective,
      parameters,
      inputs,
      metadata
    ) VALUES (
      v_child_creative_run_id,
      v_root_job.user_id,
      v_root_job.project_id,
      v_research.root_creative_run_id,
      v_child_job_id,
      'research',
      'queued',
      'Research Scout: ' || v_role,
      v_research.objective_id,
      v_assignment,
      jsonb_build_object(
        'research_run_id', v_research_run_id,
        'root_factory_job_id', v_research.factory_job_id,
        'root_creative_run_id', v_research.root_creative_run_id
      ),
      jsonb_build_object(
        'research_run_id', v_research_run_id,
        'scout_role', v_role,
        'workflow_kind', 'external_research_scout',
        'workflow_version', 1
      )
    );

    INSERT INTO public.research_scout_assignments (
      run_id, scout_role, factory_job_id, creative_run_id, assignment
    ) VALUES (
      v_research_run_id, v_role, v_child_job_id, v_child_creative_run_id, v_assignment
    );

    SELECT msg_id
    INTO v_msg_id
    FROM pgmq.send(
      'research_orchestrator_v1',
      jsonb_build_object(
        'v', 1,
        'job_id', v_child_job_id,
        'reason', 'research_scout_created',
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
      'queue:research_orchestrator_v1:enqueued:' || v_msg_id::TEXT,
      jsonb_build_object(
        'queue', 'research_orchestrator_v1',
        'queue_msg_id', v_msg_id,
        'reason', 'research_scout_created',
        'research_run_id', v_research_run_id,
        'scout_role', v_role,
        'root_factory_job_id', v_research.factory_job_id,
        'trace_id', v_trace_id
      )
    );

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'scout_role', v_role,
      'factory_job_id', v_child_job_id,
      'creative_run_id', v_child_creative_run_id,
      'duplicate', false,
      'queue_msg_id', v_msg_id
    ));
  END LOOP;

  UPDATE public.research_runs
  SET
    status = 'waiting_scouts',
    plan = v_plan,
    started_at = COALESCE(started_at, NOW()),
    error = NULL,
    updated_at = NOW()
  WHERE id = v_research_run_id;

  RETURN jsonb_build_object(
    'research_run_id', v_research_run_id,
    'status', 'waiting_scouts',
    'scout_count', jsonb_array_length(v_items),
    'scouts', v_items
  );
END;
$function$;
