-- Follow-up hardening for PR2/PR4 trigger functions.
-- Trigger execution does not require browser roles to retain direct EXECUTE rights.

REVOKE ALL ON FUNCTION public.research_progress_mirror_factory_event()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_guard_early_finalized_evidence()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.research_progress_mirror_factory_event() IS
  'Service-owned trigger function for mirroring durable workflow events into the Research trace ledger; direct API execution is revoked.';
COMMENT ON FUNCTION public.research_guard_early_finalized_evidence() IS
  'Trigger-only early-finalization evidence fence; direct API execution is revoked.';
