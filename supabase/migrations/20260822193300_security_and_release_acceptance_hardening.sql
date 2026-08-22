-- Security/release hardening identified by the 2026-08-22 production audit.
-- 1) Strip unauthenticated access to application tables/sequences.
-- 2) Remove structural and stale direct-write privileges from authenticated clients.
-- 3) Add a service-only exact-release worker heartbeat check for deployment acceptance.

-- ---------------------------------------------------------------------------
-- Client grants: anon should not read or mutate application data directly.
-- Login/auth itself is handled by Supabase Auth and does not require public-schema grants.
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Existing authenticated clients retain only the data privileges that are intentionally
-- used with RLS. Structural privileges are never needed by browser clients.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated;

-- These legacy/content tables are server-write paths. Their write RLS policies were
-- removed previously; remove the redundant table-level write grants as well.
REVOKE INSERT, UPDATE, DELETE ON TABLE
  public.assets,
  public.job_events,
  public.jobs,
  public.project_members,
  public.projects,
  public.reviews,
  public.usage_records
FROM authenticated;

-- Profiles intentionally allow authenticated self/admin UPDATE through RLS, but direct
-- INSERT/DELETE is not a browser contract.
REVOKE INSERT, DELETE ON TABLE public.profiles FROM authenticated;

-- agent_configs intentionally keeps authenticated SELECT/INSERT/UPDATE/DELETE under
-- user-scoped RLS. No change to those four data privileges here.

-- Make future migrations fail closed: new public tables/sequences receive no implicit
-- anon/authenticated grants. A migration that needs browser access must grant it explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Deployment acceptance: exact SHA + fresh heartbeat + production mode.
-- Service-role only; deploy.sh calls this after both worker containers start.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orchestrator_release_worker_ready(
  p_build_sha TEXT,
  p_queue_mode TEXT,
  p_not_before TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.orchestrator_workers AS ow
    WHERE ow.build_sha = p_build_sha
      AND ow.last_heartbeat_at >= p_not_before
      AND ow.metadata->>'queue_mode' = p_queue_mode
      AND ow.metadata->>'mock_workflows' = 'false'
  );
$function$;

REVOKE ALL ON FUNCTION public.orchestrator_release_worker_ready(TEXT, TEXT, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_release_worker_ready(TEXT, TEXT, TIMESTAMPTZ)
TO service_role;

UPDATE public.deployment_schema_contract
SET schema_version = '20260822193300',
    updated_at = NOW()
WHERE singleton = TRUE;
