-- Fail-closed production deploy contract.
--
-- Application deploys must not silently move ahead of the database schema. This
-- singleton records the schema version expected by the checked-in application,
-- while a service-role-only RPC exposes that version to the production deploy
-- script. The RPC is intentionally read-only; it does not grant DDL capability
-- to the service role.

CREATE TABLE IF NOT EXISTS public.deployment_schema_contract (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  schema_version TEXT NOT NULL CHECK (schema_version ~ '^[0-9]{14}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.deployment_schema_contract ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.deployment_schema_contract
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.deployment_schema_contract (singleton, schema_version, updated_at)
VALUES (TRUE, '20260821122000', NOW())
ON CONFLICT (singleton) DO UPDATE
SET schema_version = EXCLUDED.schema_version,
    updated_at = EXCLUDED.updated_at;

CREATE OR REPLACE FUNCTION public.orchestrator_get_deployment_schema_contract()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'schema_version', schema_version,
    'updated_at', updated_at
  )
  FROM public.deployment_schema_contract
  WHERE singleton = TRUE;
$$;

REVOKE ALL ON FUNCTION public.orchestrator_get_deployment_schema_contract()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_get_deployment_schema_contract()
  TO service_role;
