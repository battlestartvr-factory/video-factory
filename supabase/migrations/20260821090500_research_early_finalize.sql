-- Stage 4.5 PR4 — Early Research Council finalization.
-- This is a scoped optimization for the five-Scout fan-out. It never cancels the
-- root factory job or root creative run. Completed evidence is preserved and only
-- remaining non-terminal Scout child work is terminalized after a conservative
-- coverage gate is satisfied.

CREATE OR REPLACE FUNCTION public.research_get_run_finalization(p_research_run_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN rr.id IS NULL THEN jsonb_build_object(
      'found', false,
      'finalization', 'full'
    )
    ELSE jsonb_build_object(
      'found', true,
      'research_run_id', rr.id,
      'finalization', CASE
        WHEN rr.metadata->>'finalization' = 'early_finalized' THEN 'early_finalized'
        ELSE 'full'
      END,
      'early_finalized_at', rr.metadata->>'early_finalized_at'
    )
  END
  FROM (SELECT p_research_run_id AS id) AS requested
  LEFT JOIN public.research_runs AS rr ON rr.id = requested.id;
$$;

REVOKE ALL ON FUNCTION public.research_get_run_finalization(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_get_run_finalization(UUID)
  TO service_role;

COMMENT ON FUNCTION public.research_get_run_finalization(UUID) IS
  'Returns the durable Research Council finalization mode used for restart-safe synthesis.';

CREATE OR REPLACE FUNCTION public.research_early_finalize_scout_fanout(p_research_run_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run RECORD;
  v_scout_count INTEGER := 0;
  v_completed_count INTEGER := 0;
  v_failed_count INTEGER := 0;
  v_cancelled_count INTEGER := 0;
  v_nonterminal_count INTEGER := 0;
  v_evidence_count INTEGER := 0;
  v_covered_roles INTEGER := 0;
  v_critical_roles INTEGER := 0;
  v_cancelled_jobs INTEGER := 0;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_research_run_id IS NULL THEN
    RAISE EXCEPTION 'research run id is required';
  END IF;

  SELECT rr.id, rr.status, rr.metadata
  INTO v_run
  FROM public.research_runs AS rr
  WHERE rr.id = p_research_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'finalized', false,
      'reason', 'research_run_not_found',
      'finalization', 'full'
    );
  END IF;

  IF v_run.metadata->>'finalization' = 'early_finalized' THEN
    RETURN jsonb_build_object(
      'finalized', true,
      'duplicate', true,
      'reason', 'already_early_finalized',
      'finalization', 'early_finalized'
    );
  END IF;

  IF v_run.status <> 'waiting_scouts' THEN
    RETURN jsonb_build_object(
      'finalized', false,
      'reason', 'research_run_not_waiting_scouts',
      'finalization', 'full'
    );
  END IF;

  -- Serialize terminalization against child-job state changes. The root job is
  -- intentionally excluded from this lock/update boundary.
  PERFORM 1
  FROM public.research_scout_assignments AS rsa
  JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
  WHERE rsa.run_id = p_research_run_id
  FOR UPDATE OF fj;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE fj.status = 'completed'),
    COUNT(*) FILTER (WHERE fj.status = 'failed'),
    COUNT(*) FILTER (WHERE fj.status = 'cancelled'),
    COUNT(*) FILTER (WHERE fj.status NOT IN ('completed','failed','cancelled'))
  INTO
    v_scout_count,
    v_completed_count,
    v_failed_count,
    v_cancelled_count,
    v_nonterminal_count
  FROM public.research_scout_assignments AS rsa
  JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
  WHERE rsa.run_id = p_research_run_id;

  SELECT
    COUNT(e.id),
    COUNT(DISTINCT e.scout_role),
    COUNT(DISTINCT e.scout_role) FILTER (
      WHERE e.scout_role IN ('mechanics','player_voice','white_space_contrarian')
    )
  INTO v_evidence_count, v_covered_roles, v_critical_roles
  FROM public.research_evidence AS e
  WHERE e.run_id = p_research_run_id
    AND EXISTS (
      SELECT 1
      FROM public.research_scout_assignments AS rsa
      JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
      WHERE rsa.run_id = p_research_run_id
        AND rsa.scout_role = e.scout_role
        AND fj.status = 'completed'
    );

  -- Conservative PR4 gate mirrors the application eligibility check:
  -- 4 completed Scouts, >=8 source-backed evidence items, >=4 covered roles,
  -- all three critical roles represented, no existing failure/cancellation,
  -- and exactly one or more still-active child Scouts to save.
  IF v_scout_count <> 5
    OR v_completed_count < 4
    OR v_failed_count <> 0
    OR v_cancelled_count <> 0
    OR v_nonterminal_count < 1
    OR v_evidence_count < 8
    OR v_covered_roles < 4
    OR v_critical_roles < 3
  THEN
    RETURN jsonb_build_object(
      'finalized', false,
      'reason', 'coverage_threshold_not_met',
      'finalization', 'full',
      'completed_scouts', v_completed_count,
      'pending_scouts', v_nonterminal_count,
      'evidence_count', v_evidence_count,
      'covered_roles', v_covered_roles,
      'critical_roles', v_critical_roles
    );
  END IF;

  UPDATE public.factory_jobs AS fj
  SET
    cancel_requested = TRUE,
    cancel_requested_at = COALESCE(fj.cancel_requested_at, v_now),
    cancel_reason = COALESCE(fj.cancel_reason, 'research_early_finalized'),
    status = 'cancelled',
    state_reason = 'research_early_finalized',
    next_action_at = NULL,
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_heartbeat_at = NULL,
    completed_at = COALESCE(fj.completed_at, v_now),
    error = COALESCE(fj.error, jsonb_build_object(
      'code', 'RESEARCH_EARLY_FINALIZED',
      'message', 'Scout terminalized after Research Council coverage threshold was met',
      'retryable', false
    ))
  WHERE fj.id IN (
    SELECT rsa.factory_job_id
    FROM public.research_scout_assignments AS rsa
    WHERE rsa.run_id = p_research_run_id
  )
    AND fj.status NOT IN ('completed','failed','cancelled');
  GET DIAGNOSTICS v_cancelled_jobs = ROW_COUNT;

  UPDATE public.factory_job_stages AS stage
  SET
    status = 'cancelled',
    finished_at = COALESCE(stage.finished_at, v_now)
  WHERE stage.job_id IN (
    SELECT rsa.factory_job_id
    FROM public.research_scout_assignments AS rsa
    WHERE rsa.run_id = p_research_run_id
  )
    AND stage.status NOT IN ('succeeded','failed','cancelled');

  UPDATE public.provider_tasks AS task
  SET
    status = 'cancelled',
    next_check_at = NULL,
    error = COALESCE(task.error, jsonb_build_object(
      'code', 'RESEARCH_EARLY_FINALIZED',
      'message', 'Local provider reconciliation stopped after Research Council early finalization'
    ))
  WHERE task.job_id IN (
    SELECT rsa.factory_job_id
    FROM public.research_scout_assignments AS rsa
    WHERE rsa.run_id = p_research_run_id
  )
    AND task.status NOT IN ('succeeded','failed','cancelled');

  UPDATE public.research_scout_assignments AS rsa
  SET metadata = rsa.metadata || jsonb_build_object(
    'early_finalized', true,
    'early_finalized_at', v_now,
    'finalization_reason', 'coverage_threshold_met'
  )
  WHERE rsa.run_id = p_research_run_id
    AND EXISTS (
      SELECT 1
      FROM public.factory_jobs AS fj
      WHERE fj.id = rsa.factory_job_id
        AND fj.cancel_reason = 'research_early_finalized'
    );

  UPDATE public.research_runs AS rr
  SET
    metadata = rr.metadata || jsonb_build_object(
      'finalization', 'early_finalized',
      'early_finalized_at', v_now,
      'early_finalize_completed_scouts', v_completed_count,
      'early_finalize_cancelled_scouts', v_cancelled_jobs,
      'early_finalize_evidence_count', v_evidence_count,
      'early_finalize_covered_roles', v_covered_roles,
      'early_finalize_critical_roles', v_critical_roles
    ),
    updated_at = v_now
  WHERE rr.id = p_research_run_id;

  INSERT INTO public.factory_workflow_events(job_id, event_type, dedupe_key, payload)
  SELECT
    rsa.factory_job_id,
    'research.scout_early_finalized',
    'research:scout_early_finalized:' || p_research_run_id::TEXT || ':' || rsa.scout_role,
    jsonb_build_object(
      'research_run_id', p_research_run_id,
      'scout_role', rsa.scout_role,
      'reason', 'coverage_threshold_met',
      'completed_scouts', v_completed_count,
      'evidence_count', v_evidence_count,
      'covered_roles', v_covered_roles,
      'terminalized_at', v_now
    )
  FROM public.research_scout_assignments AS rsa
  JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
  WHERE rsa.run_id = p_research_run_id
    AND fj.cancel_reason = 'research_early_finalized'
  ON CONFLICT (dedupe_key) DO NOTHING;

  RETURN jsonb_build_object(
    'finalized', true,
    'duplicate', false,
    'reason', 'coverage_threshold_met',
    'finalization', 'early_finalized',
    'completed_scouts', v_completed_count,
    'terminalized_scouts', v_cancelled_jobs,
    'evidence_count', v_evidence_count,
    'covered_roles', v_covered_roles,
    'critical_roles', v_critical_roles
  );
END;
$$;

REVOKE ALL ON FUNCTION public.research_early_finalize_scout_fanout(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_early_finalize_scout_fanout(UUID)
  TO service_role;

COMMENT ON FUNCTION public.research_early_finalize_scout_fanout(UUID) IS
  'Atomically terminalizes only remaining Scout child jobs after conservative Research Council coverage is sufficient; root workflow is never cancelled.';

-- A late-running Scout may finish its external call after its child job was scoped-cancelled.
-- Reject new evidence in that case so synthesis remains a stable snapshot. Because Scout
-- evidence bundles are persisted inside one transaction, raising here rolls back any
-- source/evidence writes from that late bundle.
CREATE OR REPLACE FUNCTION public.research_guard_early_finalized_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.research_scout_assignments AS rsa
    JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
    WHERE rsa.run_id = NEW.run_id
      AND rsa.scout_role = NEW.scout_role
      AND fj.cancel_reason = 'research_early_finalized'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_EARLY_FINALIZED: late Scout evidence rejected';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_early_finalize_evidence_guard ON public.research_evidence;
CREATE TRIGGER research_early_finalize_evidence_guard
  BEFORE INSERT ON public.research_evidence
  FOR EACH ROW
  EXECUTE FUNCTION public.research_guard_early_finalized_evidence();

-- Fence late Scout reports as well. This preserves the original idempotent report
-- behavior while refusing a first write from a child that has already been scoped-cancelled.
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

  SELECT
    rsa.run_id,
    rsa.scout_role,
    rsa.creative_run_id,
    cr.outputs,
    fj.status AS job_status,
    fj.cancel_reason
  INTO v_row
  FROM public.research_scout_assignments AS rsa
  JOIN public.creative_runs AS cr ON cr.id = rsa.creative_run_id
  JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
  WHERE rsa.factory_job_id = v_job_id
  FOR UPDATE OF cr, fj;

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

  IF v_row.cancel_reason = 'research_early_finalized'
    OR v_row.job_status = 'cancelled'
  THEN
    RAISE EXCEPTION 'RESEARCH_EARLY_FINALIZED: late Scout report rejected';
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
