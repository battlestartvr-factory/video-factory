-- Advance the fail-closed deployment schema contract after restoring the queue-aware
-- parked-waiting orchestration semantics.

UPDATE public.deployment_schema_contract
SET schema_version = '20260821142500',
    updated_at = NOW()
WHERE singleton = TRUE;
