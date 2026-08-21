-- PR4 concurrency hardening: serialize Scout evidence insertion against scoped
-- early-finalize cancellation. A plain MVCC read can otherwise observe the old
-- child-job row while the finalizer has an uncommitted cancellation in flight.

CREATE OR REPLACE FUNCTION public.research_guard_early_finalized_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_status TEXT;
  v_cancel_reason TEXT;
BEGIN
  -- FOR SHARE conflicts with the finalizer's row update lock. Therefore either:
  -- 1) this evidence insert wins the lock and commits before finalization, or
  -- 2) finalization wins, this statement waits, then observes the terminal row
  --    and rejects the late bundle. There is no post-finalize write window.
  SELECT fj.status, fj.cancel_reason
  INTO v_job_status, v_cancel_reason
  FROM public.research_scout_assignments AS rsa
  JOIN public.factory_jobs AS fj ON fj.id = rsa.factory_job_id
  WHERE rsa.run_id = NEW.run_id
    AND rsa.scout_role = NEW.scout_role
  FOR SHARE OF fj;

  IF v_cancel_reason = 'research_early_finalized' THEN
    RAISE EXCEPTION 'RESEARCH_EARLY_FINALIZED: late Scout evidence rejected';
  END IF;

  IF v_job_status = 'cancelled' THEN
    RAISE EXCEPTION 'RESEARCH_SCOUT_CANCELLED: late Scout evidence rejected';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.research_guard_early_finalized_evidence() IS
  'Serializes evidence insertion with Scout cancellation so no evidence can commit after the early-finalize boundary.';
