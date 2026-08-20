-- Stage 4.5 PR3 — durable Research Director + independent Research Scout jobs.
-- Additive orchestration: factory_jobs / creative_runs remain authoritative execution/lineage.
-- The dedicated research queue isolates cheap parallel research from the conservative media worker.

-- ---------------------------------------------------------------------------
-- Dedicated logged PGMQ queue for Research Scout / later Concept Council child jobs.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pgmq.list_queues() AS q
    WHERE q.queue_name = 'research_orchestrator_v1'
  ) THEN
    PERFORM pgmq.create('research_orchestrator_v1');
  END IF;
END $$;

-- Keep queue routing deterministic and code-controlled. Unknown/current workflows stay
-- on the existing core queue; only explicitly versioned research child kinds are routed away.
CREATE OR REPLACE FUNCTION public.orchestrator_queue_name_for_workflow(p_workflow_kind TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_workflow_kind IN ('external_research_scout', 'concept_council_member')
      THEN 'research_orchestrator_v1'
    ELSE 'core_orchestrator_v1'
  END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_queue_name_for_workflow(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_queue_name_for_workflow(TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Idempotent durable mapping between one ResearchRun role and one child job/run.
-- The unique (run_id, scout_role) identity is the fan-out idempotency boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.research_scout_assignments (
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  scout_role TEXT NOT NULL CHECK (
    scout_role IN ('market_competitor','mechanics','player_voice','gameplay_visual','white_space_contrarian')
  ),
  factory_job_id UUID NOT NULL UNIQUE REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  creative_run_id UUID NOT NULL UNIQUE REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  assignment JSONB NOT NULL CHECK (jsonb_typeof(assignment) = 'object'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, scout_role)
);

CREATE INDEX IF NOT EXISTS idx_research_scout_assignments_job
  ON public.research_scout_assignments(factory_job_id);
CREATE INDEX IF NOT EXISTS idx_research_scout_assignments_creative
  ON public.research_scout_assignments(creative_run_id);

ALTER TABLE public.research_scout_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.research_scout_assignments FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.research_scout_assignments TO service_role;

COMMENT ON TABLE public.research_scout_assignments IS
  'Stage 4.5 durable fan-out identity. Execution state stays in factory_jobs; Scout output stays on the child creative_run.';

-- ---------------------------------------------------------------------------
-- Research Director fan-out.
-- One call creates at most five independent child jobs, one for each canonical role.
-- The ResearchRun row lock serializes duplicate/root retries so no role can be spawned twice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.research_director_fanout(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
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
      'queue:enqueued:' || v_msg_id::TEXT,
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
$$;

REVOKE ALL ON FUNCTION public.research_director_fanout(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_director_fanout(JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Scout child context / report persistence.
-- A persisted report is checked before the executor runs, so a worker crash after
-- report persistence but before factory-job finish does not repeat the Scout call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.research_begin_scout_job(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_report JSONB;
BEGIN
  SELECT
    rsa.run_id,
    rsa.scout_role,
    rsa.assignment,
    rsa.creative_run_id,
    rr.factory_job_id AS root_factory_job_id,
    rr.root_creative_run_id,
    rr.objective_id,
    cr.status AS creative_status,
    cr.outputs
  INTO v_row
  FROM public.research_scout_assignments AS rsa
  JOIN public.research_runs AS rr ON rr.id = rsa.run_id
  JOIN public.creative_runs AS cr ON cr.id = rsa.creative_run_id
  WHERE rsa.factory_job_id = p_job_id
  FOR UPDATE OF cr;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'research Scout assignment not found for job %', p_job_id;
  END IF;

  v_report := v_row.outputs->'scout_report';

  IF v_report IS NULL THEN
    UPDATE public.creative_runs
    SET
      status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
      started_at = COALESCE(started_at, NOW())
    WHERE id = v_row.creative_run_id
      AND status NOT IN ('completed','failed','cancelled');
  END IF;

  RETURN jsonb_build_object(
    'research_run_id', v_row.run_id,
    'scout_role', v_row.scout_role,
    'assignment', v_row.assignment,
    'creative_run_id', v_row.creative_run_id,
    'root_factory_job_id', v_row.root_factory_job_id,
    'root_creative_run_id', v_row.root_creative_run_id,
    'objective_id', v_row.objective_id,
    'existing_report', v_report
  );
END;
$$;

REVOKE ALL ON FUNCTION public.research_begin_scout_job(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_begin_scout_job(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.research_persist_scout_report(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID := NULLIF(payload->>'job_id', '')::UUID;
  v_report JSONB := payload->'report';
  v_usage JSONB := COALESCE(payload->'usage', '{}'::JSONB);
  v_model TEXT := NULLIF(trim(payload->>'model'), '');
  v_provider TEXT := NULLIF(trim(payload->>'provider'), '');
  v_row RECORD;
  v_existing JSONB;
BEGIN
  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'job_id is required';
  END IF;
  IF jsonb_typeof(v_report) <> 'object' THEN
    RAISE EXCEPTION 'report must be an object';
  END IF;
  IF v_report->>'schema' <> 'research_scout_report' OR COALESCE((v_report->>'version')::INTEGER, 0) <> 1 THEN
    RAISE EXCEPTION 'unsupported research Scout report schema/version';
  END IF;

  SELECT rsa.run_id, rsa.scout_role, rsa.creative_run_id, cr.outputs
  INTO v_row
  FROM public.research_scout_assignments AS rsa
  JOIN public.creative_runs AS cr ON cr.id = rsa.creative_run_id
  WHERE rsa.factory_job_id = v_job_id
  FOR UPDATE OF cr;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'research Scout assignment not found for job %', v_job_id;
  END IF;

  IF v_report->>'researchRunId' IS DISTINCT FROM v_row.run_id::TEXT THEN
    RAISE EXCEPTION 'Scout report researchRunId does not match durable assignment';
  END IF;
  IF v_report->>'scoutRole' IS DISTINCT FROM v_row.scout_role THEN
    RAISE EXCEPTION 'Scout report role does not match durable assignment';
  END IF;

  v_existing := v_row.outputs->'scout_report';
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'persisted', true,
      'duplicate', true,
      'creative_run_id', v_row.creative_run_id,
      'report', v_existing
    );
  END IF;

  UPDATE public.creative_runs
  SET
    status = 'completed',
    outputs = jsonb_set(COALESCE(outputs, '{}'::JSONB), '{scout_report}', v_report, true),
    usage = v_usage,
    model = COALESCE(v_model, model),
    provider = COALESCE(v_provider, provider),
    started_at = COALESCE(started_at, NOW()),
    completed_at = COALESCE(completed_at, NOW()),
    error_code = NULL,
    error_message = NULL
  WHERE id = v_row.creative_run_id;

  RETURN jsonb_build_object(
    'persisted', true,
    'duplicate', false,
    'creative_run_id', v_row.creative_run_id,
    'report', v_report
  );
END;
$$;

REVOKE ALL ON FUNCTION public.research_persist_scout_report(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_persist_scout_report(JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.research_get_scout_fanout_status(p_research_run_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH items AS (
    SELECT
      rsa.scout_role,
      rsa.factory_job_id,
      rsa.creative_run_id,
      fj.status AS job_status,
      fj.retry_count,
      fj.error,
      cr.outputs->'scout_report' AS report
    FROM public.research_scout_assignments AS rsa
    JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
    JOIN public.creative_runs AS cr ON cr.id = rsa.creative_run_id
    WHERE rsa.run_id = p_research_run_id
  )
  SELECT jsonb_build_object(
    'research_run_id', p_research_run_id,
    'scout_count', COUNT(*),
    'terminal_count', COUNT(*) FILTER (WHERE job_status IN ('completed','failed','cancelled')),
    'completed_count', COUNT(*) FILTER (WHERE job_status = 'completed'),
    'failed_count', COUNT(*) FILTER (WHERE job_status = 'failed'),
    'cancelled_count', COUNT(*) FILTER (WHERE job_status = 'cancelled'),
    'all_terminal', COUNT(*) = 5 AND BOOL_AND(job_status IN ('completed','failed','cancelled')),
    'items', COALESCE(
      jsonb_agg(jsonb_build_object(
        'scout_role', scout_role,
        'factory_job_id', factory_job_id,
        'creative_run_id', creative_run_id,
        'job_status', job_status,
        'retry_count', retry_count,
        'error', error,
        'report', report
      ) ORDER BY scout_role),
      '[]'::JSONB
    )
  )
  FROM items;
$$;

REVOKE ALL ON FUNCTION public.research_get_scout_fanout_status(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_get_scout_fanout_status(UUID)
  TO service_role;

-- Keep child creative_run terminal state aligned even when a Scout fails/cancels before
-- it can persist a report. This trigger is intentionally scoped to Scout child jobs.
CREATE OR REPLACE FUNCTION public.research_sync_scout_creative_run_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.workflow_kind <> 'external_research_scout'
    OR NEW.status NOT IN ('completed','failed','cancelled')
  THEN
    RETURN NEW;
  END IF;

  UPDATE public.creative_runs AS cr
  SET
    status = NEW.status,
    completed_at = COALESCE(cr.completed_at, NEW.completed_at, NOW()),
    error_code = CASE WHEN NEW.status = 'failed' THEN COALESCE(NEW.error->>'code', cr.error_code) ELSE cr.error_code END,
    error_message = CASE WHEN NEW.status = 'failed' THEN COALESCE(NEW.error->>'message', cr.error_message) ELSE cr.error_message END
  FROM public.research_scout_assignments AS rsa
  WHERE rsa.factory_job_id = NEW.id
    AND cr.id = rsa.creative_run_id
    AND cr.status NOT IN ('failed','cancelled')
    AND (cr.status <> 'completed' OR NEW.status = 'completed');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_scout_factory_job_terminal_sync ON public.factory_jobs;
CREATE TRIGGER research_scout_factory_job_terminal_sync
  AFTER UPDATE OF status ON public.factory_jobs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.research_sync_scout_creative_run_terminal();

-- ---------------------------------------------------------------------------
-- Dedicated research queue receive/ACK wrappers. PGMQ remains service-only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.research_orchestrator_read_queue(
  p_visibility_seconds INTEGER DEFAULT 120,
  p_qty INTEGER DEFAULT 5
)
RETURNS TABLE (
  msg_id BIGINT,
  read_ct INTEGER,
  enqueued_at TIMESTAMPTZ,
  vt TIMESTAMPTZ,
  message JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
BEGIN
  IF p_visibility_seconds < 1 OR p_visibility_seconds > 3600 THEN
    RAISE EXCEPTION 'visibility_seconds must be between 1 and 3600';
  END IF;
  IF p_qty < 1 OR p_qty > 10 THEN
    RAISE EXCEPTION 'qty must be between 1 and 10';
  END IF;

  RETURN QUERY
  SELECT q.msg_id, q.read_ct, q.enqueued_at, q.vt, q.message
  FROM pgmq.read('research_orchestrator_v1', p_visibility_seconds, p_qty) AS q;
END;
$$;

REVOKE ALL ON FUNCTION public.research_orchestrator_read_queue(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_orchestrator_read_queue(INTEGER, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION public.research_orchestrator_archive_queue_message(p_msg_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_archived BOOLEAN;
BEGIN
  SELECT pgmq.archive('research_orchestrator_v1', p_msg_id)
  INTO v_archived;
  RETURN COALESCE(v_archived, false);
END;
$$;

REVOKE ALL ON FUNCTION public.research_orchestrator_archive_queue_message(BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_orchestrator_archive_queue_message(BIGINT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Queue-aware lease heartbeat. Signature remains unchanged for all existing workers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_heartbeat_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_token UUID,
  p_msg_id BIGINT,
  p_lease_seconds INTEGER DEFAULT 90,
  p_visibility_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_job RECORD;
  v_queue_msg_id BIGINT;
  v_queue_message JSONB;
  v_expires_at TIMESTAMPTZ;
  v_queue_name TEXT;
BEGIN
  IF p_lease_seconds < 15 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease_seconds must be between 15 and 900';
  END IF;
  IF p_visibility_seconds < 15 OR p_visibility_seconds > 3600 THEN
    RAISE EXCEPTION 'visibility_seconds must be between 15 and 3600';
  END IF;

  SELECT status, workflow_kind, lease_owner, lease_token, lease_expires_at
  INTO v_job
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'job_not_found');
  END IF;
  IF v_job.status <> 'running'
    OR v_job.lease_owner IS DISTINCT FROM p_worker_id
    OR v_job.lease_token IS DISTINCT FROM p_lease_token
  THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'lease_mismatch');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= NOW() THEN
    RETURN jsonb_build_object('renewed', false, 'reason', 'lease_expired');
  END IF;

  v_queue_name := public.orchestrator_queue_name_for_workflow(v_job.workflow_kind);

  SELECT q.msg_id, q.message
  INTO v_queue_msg_id, v_queue_message
  FROM pgmq.set_vt(v_queue_name, p_msg_id, p_visibility_seconds) AS q;

  IF v_queue_msg_id IS NULL THEN
    RAISE EXCEPTION 'queue message % not found in % while renewing lease', p_msg_id, v_queue_name;
  END IF;
  IF v_queue_message->>'job_id' IS DISTINCT FROM p_job_id::TEXT THEN
    RAISE EXCEPTION 'queue message % belongs to another job', p_msg_id;
  END IF;

  v_expires_at := NOW() + make_interval(secs => p_lease_seconds);
  UPDATE public.factory_jobs
  SET lease_expires_at = v_expires_at, last_heartbeat_at = NOW()
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'renewed', true,
    'lease_expires_at', v_expires_at,
    'queue', v_queue_name,
    'queue_visibility_seconds', p_visibility_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_heartbeat_job(UUID, TEXT, UUID, BIGINT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_heartbeat_job(UUID, TEXT, UUID, BIGINT, INTEGER, INTEGER)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Queue-aware fenced finish. Existing signature/transition/retry semantics stay intact;
-- only the next wake queue is selected from the durable workflow kind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_finish_tick(
  p_job_id UUID,
  p_worker_id TEXT,
  p_lease_token UUID,
  p_new_status TEXT,
  p_state JSONB DEFAULT NULL,
  p_current_stage TEXT DEFAULT NULL,
  p_progress SMALLINT DEFAULT NULL,
  p_next_action_at TIMESTAMPTZ DEFAULT NULL,
  p_result JSONB DEFAULT NULL,
  p_error JSONB DEFAULT NULL,
  p_state_reason TEXT DEFAULT NULL,
  p_event_type TEXT DEFAULT 'job.transitioned',
  p_event_payload JSONB DEFAULT '{}'::JSONB,
  p_creative_run_id UUID DEFAULT NULL,
  p_enqueue_reason TEXT DEFAULT NULL,
  p_trace_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_job RECORD;
  v_delay_seconds INTEGER := 0;
  v_msg_id BIGINT;
  v_trace_id UUID := COALESCE(p_trace_id, gen_random_uuid());
  v_enqueue_reason TEXT;
  v_effective_next_action TIMESTAMPTZ;
  v_retry_count INTEGER;
  v_queue_name TEXT;
BEGIN
  SELECT status, workflow_kind, lease_owner, lease_token, lease_expires_at, retry_count
  INTO v_job
  FROM public.factory_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'job_not_found');
  END IF;
  IF v_job.status <> 'running'
    OR v_job.lease_owner IS DISTINCT FROM p_worker_id
    OR v_job.lease_token IS DISTINCT FROM p_lease_token
  THEN
    RETURN jsonb_build_object('success', false, 'reason', 'lease_mismatch');
  END IF;
  IF v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= NOW() THEN
    RETURN jsonb_build_object('success', false, 'reason', 'lease_expired');
  END IF;

  IF p_new_status NOT IN (
    'queued', 'waiting', 'retrying', 'awaiting_approval',
    'completed', 'failed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'invalid running transition target: %', p_new_status;
  END IF;
  IF p_progress IS NOT NULL AND (p_progress < 0 OR p_progress > 100) THEN
    RAISE EXCEPTION 'progress must be between 0 and 100';
  END IF;
  IF p_new_status IN ('waiting', 'retrying') AND p_next_action_at IS NULL THEN
    RAISE EXCEPTION '% requires next_action_at for durable recovery', p_new_status;
  END IF;

  IF p_new_status = 'queued' THEN
    v_effective_next_action := NOW();
    v_enqueue_reason := COALESCE(NULLIF(trim(p_enqueue_reason), ''), 'next_stage');
  ELSIF p_new_status IN ('waiting', 'retrying') THEN
    v_effective_next_action := p_next_action_at;
    v_delay_seconds := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (p_next_action_at - NOW())))::INTEGER);
    v_enqueue_reason := COALESCE(
      NULLIF(trim(p_enqueue_reason), ''),
      CASE WHEN p_new_status = 'retrying' THEN 'retry' ELSE 'reconcile' END
    );
  ELSE
    v_effective_next_action := NULL;
  END IF;

  v_retry_count := v_job.retry_count + CASE WHEN p_new_status = 'retrying' THEN 1 ELSE 0 END;
  v_queue_name := public.orchestrator_queue_name_for_workflow(v_job.workflow_kind);

  UPDATE public.factory_jobs
  SET
    status = p_new_status,
    current_stage = COALESCE(p_current_stage, current_stage),
    progress = COALESCE(p_progress, progress),
    state = COALESCE(p_state, state),
    result = COALESCE(p_result, result),
    error = p_error,
    retry_count = v_retry_count,
    state_reason = p_state_reason,
    next_action_at = v_effective_next_action,
    completed_at = CASE
      WHEN p_new_status IN ('completed', 'failed', 'cancelled') THEN COALESCE(completed_at, NOW())
      ELSE NULL
    END,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL
  WHERE id = p_job_id;

  INSERT INTO public.factory_workflow_events (
    job_id, creative_run_id, event_type, dedupe_key, payload
  ) VALUES (
    p_job_id,
    p_creative_run_id,
    COALESCE(NULLIF(trim(p_event_type), ''), 'job.transitioned'),
    'job:transition:' || p_job_id::TEXT || ':' || p_lease_token::TEXT,
    COALESCE(p_event_payload, '{}'::JSONB) || jsonb_build_object(
      'from_status', 'running',
      'to_status', p_new_status,
      'worker_id', p_worker_id,
      'retry_count', v_retry_count
    )
  );

  IF p_new_status IN ('queued', 'waiting', 'retrying') THEN
    SELECT msg_id
    INTO v_msg_id
    FROM pgmq.send(
      v_queue_name,
      jsonb_build_object(
        'v', 1,
        'job_id', p_job_id,
        'reason', v_enqueue_reason,
        'trace_id', v_trace_id
      ),
      v_delay_seconds
    ) AS msg_id;

    UPDATE public.factory_jobs SET last_enqueued_at = NOW() WHERE id = p_job_id;

    INSERT INTO public.factory_workflow_events (
      job_id, creative_run_id, event_type, dedupe_key, payload
    ) VALUES (
      p_job_id,
      p_creative_run_id,
      'job.enqueued',
      'queue:enqueued:' || v_msg_id::TEXT,
      jsonb_build_object(
        'queue', v_queue_name,
        'queue_msg_id', v_msg_id,
        'reason', v_enqueue_reason,
        'delay_seconds', v_delay_seconds,
        'trace_id', v_trace_id
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', p_new_status,
    'retry_count', v_retry_count,
    'queue_msg_id', v_msg_id,
    'next_action_at', v_effective_next_action,
    'trace_id', CASE WHEN v_msg_id IS NULL THEN NULL ELSE v_trace_id END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_finish_tick(
  UUID, TEXT, UUID, TEXT, JSONB, TEXT, SMALLINT, TIMESTAMPTZ,
  JSONB, JSONB, TEXT, TEXT, JSONB, UUID, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_finish_tick(
  UUID, TEXT, UUID, TEXT, JSONB, TEXT, SMALLINT, TIMESTAMPTZ,
  JSONB, JSONB, TEXT, TEXT, JSONB, UUID, TEXT, UUID
) TO service_role;

-- ---------------------------------------------------------------------------
-- Queue-aware watchdog: DB state still reconstructs wake-ups, but each job is sent
-- back to the queue corresponding to its durable workflow kind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_watchdog_recover(
  p_limit INTEGER DEFAULT 50,
  p_reenqueue_after_seconds INTEGER DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgmq
AS $$
DECLARE
  v_job RECORD;
  v_msg_id BIGINT;
  v_recovered INTEGER := 0;
  v_stale_leases INTEGER := 0;
  v_queue_name TEXT;
BEGIN
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'limit must be between 1 and 500';
  END IF;
  IF p_reenqueue_after_seconds < 15 OR p_reenqueue_after_seconds > 3600 THEN
    RAISE EXCEPTION 'reenqueue_after_seconds must be between 15 and 3600';
  END IF;

  FOR v_job IN
    SELECT fj.id, fj.status, fj.workflow_kind, fj.lease_token, fj.lease_expires_at
    FROM public.factory_jobs fj
    WHERE
      (
        fj.status IN ('queued', 'waiting', 'retrying')
        AND (fj.next_action_at IS NULL OR fj.next_action_at <= NOW())
        AND (
          fj.last_enqueued_at IS NULL
          OR fj.last_enqueued_at <= NOW() - make_interval(secs => p_reenqueue_after_seconds)
        )
      )
      OR (
        fj.status = 'running'
        AND fj.lease_expires_at IS NOT NULL
        AND fj.lease_expires_at <= NOW()
      )
    ORDER BY COALESCE(fj.next_action_at, fj.lease_expires_at, fj.created_at), fj.created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_job.status = 'running' THEN
      v_stale_leases := v_stale_leases + 1;

      UPDATE public.factory_job_stages
      SET
        status = 'interrupted',
        finished_at = COALESCE(finished_at, NOW()),
        error = COALESCE(error, jsonb_build_object('code', 'STALE_LEASE', 'message', 'Worker lease expired'))
      WHERE job_id = v_job.id
        AND status IN ('running', 'submitted', 'processing');

      UPDATE public.factory_jobs
      SET
        status = 'queued',
        state_reason = 'watchdog_stale_lease',
        next_action_at = NOW(),
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_heartbeat_at = NULL
      WHERE id = v_job.id;
    END IF;

    v_queue_name := public.orchestrator_queue_name_for_workflow(v_job.workflow_kind);

    SELECT msg_id
    INTO v_msg_id
    FROM pgmq.send(
      v_queue_name,
      jsonb_build_object(
        'v', 1,
        'job_id', v_job.id,
        'reason', CASE WHEN v_job.status = 'running' THEN 'stale_lease' ELSE 'watchdog' END,
        'trace_id', gen_random_uuid()
      ),
      0
    ) AS msg_id;

    UPDATE public.factory_jobs
    SET last_enqueued_at = NOW()
    WHERE id = v_job.id;

    INSERT INTO public.factory_workflow_events (job_id, event_type, dedupe_key, payload)
    VALUES (
      v_job.id,
      CASE WHEN v_job.status = 'running' THEN 'job.recovered' ELSE 'job.enqueued' END,
      'watchdog:enqueue:' || v_msg_id::TEXT,
      jsonb_build_object(
        'queue', v_queue_name,
        'queue_msg_id', v_msg_id,
        'previous_status', v_job.status,
        'reason', CASE WHEN v_job.status = 'running' THEN 'stale_lease' ELSE 'watchdog' END
      )
    );

    v_recovered := v_recovered + 1;
  END LOOP;

  RETURN jsonb_build_object('recovered', v_recovered, 'stale_leases', v_stale_leases);
END;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_watchdog_recover(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_watchdog_recover(INTEGER, INTEGER)
  TO service_role;
