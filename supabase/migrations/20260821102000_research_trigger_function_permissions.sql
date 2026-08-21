-- Follow-up hardening for PR2/PR4 after production advisor validation.
-- Trigger execution does not require browser roles to retain direct EXECUTE rights,
-- and every research_progress_events foreign key gets a covering access path.

REVOKE ALL ON FUNCTION public.research_progress_mirror_factory_event()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_guard_early_finalized_evidence()
  FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_research_progress_job_sequence
  ON public.research_progress_events(job_id, sequence_id)
  WHERE job_id IS NOT NULL;

COMMENT ON FUNCTION public.research_progress_mirror_factory_event() IS
  'Service-owned trigger function for mirroring durable workflow events into the Research trace ledger; direct API execution is revoked.';
COMMENT ON FUNCTION public.research_guard_early_finalized_evidence() IS
  'Trigger-only early-finalization evidence fence; direct API execution is revoked.';
