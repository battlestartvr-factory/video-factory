-- Stage 3 pre-merge security cleanup for low-risk legacy advisor findings.
--
-- These two SECURITY DEFINER functions are trigger-only entry points. Browser roles do
-- not need direct RPC EXECUTE permission to fire their owning table triggers.
REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_profile_sensitive_fields()
  FROM PUBLIC, anon, authenticated;

-- Pin the invoker search path for the knowledge FTS helper. This keeps the existing
-- function semantics while removing role-mutable object resolution.
ALTER FUNCTION public.search_knowledge_chunks(UUID[], TEXT, INTEGER)
  SET search_path = public;
