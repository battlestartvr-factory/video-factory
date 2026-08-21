-- Game Discovery v2 concept persistence was introduced after the Stage 4 event
-- dedupe-contract repair and accidentally repeated the same invalid composite
-- ON CONFLICT target. factory_workflow_events intentionally owns global
-- UNIQUE(dedupe_key), so PostgreSQL rejects ON CONFLICT(job_id, dedupe_key).
--
-- Keep the established global idempotency contract and make this static v2 event
-- key job-scoped so independent discovery runs cannot collide with each other.

DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.proname = 'orchestrator_persist_game_discovery_v2_concepts'
  ORDER BY p.oid
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'required function orchestrator_persist_game_discovery_v2_concepts not found';
  END IF;

  IF strpos(v_def, 'ON CONFLICT (job_id, dedupe_key) DO NOTHING') = 0 THEN
    RAISE EXCEPTION 'v2 concept persistence function does not contain the expected composite event conflict target';
  END IF;

  IF strpos(v_def, '''stage4.5:pr7:curated-concepts-persisted''') = 0 THEN
    RAISE EXCEPTION 'v2 concept persisted event dedupe marker not found';
  END IF;

  v_def := replace(
    v_def,
    'ON CONFLICT (job_id, dedupe_key) DO NOTHING',
    'ON CONFLICT (dedupe_key) DO NOTHING'
  );

  v_def := replace(
    v_def,
    '''stage4.5:pr7:curated-concepts-persisted''',
    '''stage4.5:pr7:curated-concepts-persisted:'' || v_job_id::TEXT'
  );

  EXECUTE v_def;
END
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_game_discovery_v2_concepts(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_game_discovery_v2_concepts(JSONB)
  TO service_role;
