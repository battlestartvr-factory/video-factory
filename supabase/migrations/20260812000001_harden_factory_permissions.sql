-- Harden factory table privileges for anon/authenticated.
-- Complements RLS from 20260812000000_factory_content_system.sql.
-- Does NOT modify legacy jobs/assets tables or factory RPC helpers.

-- ---------------------------------------------------------------------------
-- 1. Revoke client write privileges on factory + webhook tables
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'factory_jobs',
    'factory_job_stages',
    'provider_models',
    'provider_tasks',
    'factory_assets',
    'factory_approvals',
    'factory_workflow_events',
    'factory_cost_events',
    'processed_webhook_events'
  ]
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM anon, authenticated',
      tbl
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Revoke direct SELECT on service-only tables (RLS has no client policies)
-- ---------------------------------------------------------------------------
REVOKE SELECT ON TABLE public.provider_models FROM anon, authenticated;
REVOKE SELECT ON TABLE public.provider_tasks FROM anon, authenticated;
REVOKE SELECT ON TABLE public.factory_workflow_events FROM anon, authenticated;
REVOKE SELECT ON TABLE public.processed_webhook_events FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Block direct SELECT on column-masked base tables; safe views are the client path
--    security_invoker=true cannot mask columns when callers retain base-table SELECT.
--    These views run as owner (security_invoker=false) and enforce access via helper.
-- ---------------------------------------------------------------------------
REVOKE SELECT ON TABLE public.factory_assets FROM anon, authenticated;
REVOKE SELECT ON TABLE public.factory_job_stages FROM anon, authenticated;

CREATE OR REPLACE VIEW public.factory_job_stages_safe
WITH (security_invoker = false)
AS
SELECT
  js.id,
  js.job_id,
  js.stage,
  js.status,
  js.attempt,
  js.started_at,
  js.finished_at,
  js.created_at,
  js.updated_at
FROM public.factory_job_stages AS js
WHERE public.has_factory_job_access(auth.uid(), js.job_id);

CREATE OR REPLACE VIEW public.factory_assets_safe
WITH (security_invoker = false)
AS
SELECT
  fa.id,
  fa.job_id,
  fa.stage_id,
  fa.variant_index,
  fa.kind,
  fa.storage,
  CASE
    WHEN fa.storage = 'b2' THEN NULL
    ELSE fa.source_url
  END AS source_url,
  fa.drive_web_url,
  CASE
    WHEN fa.storage = 'inline' OR fa.kind = 'text' THEN fa.text_content
    ELSE NULL
  END AS text_content,
  fa.mime_type,
  fa.size_bytes,
  fa.approved,
  fa.created_at,
  fa.updated_at
FROM public.factory_assets AS fa
WHERE public.has_factory_job_access(auth.uid(), fa.job_id);

-- factory_job_detail keeps security_invoker=true (no column masking; RLS on factory_jobs applies)
-- Re-grant in case prior default grants were altered by view recreation above.
GRANT SELECT ON public.factory_job_detail TO authenticated;

GRANT SELECT ON public.factory_job_stages_safe TO authenticated;
GRANT SELECT ON public.factory_assets_safe TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Revoke write privileges on safe views (Supabase default grants all)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  vw TEXT;
BEGIN
  FOREACH vw IN ARRAY ARRAY[
    'factory_job_stages_safe',
    'factory_assets_safe',
    'factory_job_detail'
  ]
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM anon, authenticated',
      vw
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Strip all anon access (CREATE OR REPLACE VIEW may preserve default grants)
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON TABLE
  public.factory_jobs,
  public.factory_job_stages,
  public.provider_models,
  public.provider_tasks,
  public.factory_assets,
  public.factory_approvals,
  public.factory_workflow_events,
  public.factory_cost_events,
  public.processed_webhook_events,
  public.factory_job_stages_safe,
  public.factory_assets_safe,
  public.factory_job_detail
FROM anon;

-- service_role retains full privileges via Supabase defaults; no REVOKE here.
