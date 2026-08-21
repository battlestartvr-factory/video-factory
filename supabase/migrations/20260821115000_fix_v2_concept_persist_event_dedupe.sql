-- Game Discovery v2 concept persistence was introduced after the Stage 4 event
-- dedupe-contract repair and accidentally repeated the same invalid composite
-- ON CONFLICT target. factory_workflow_events intentionally owns global
-- UNIQUE(dedupe_key), so PostgreSQL rejects ON CONFLICT(job_id, dedupe_key).
--
-- Keep the established global idempotency contract and make this static v2 event
-- key job-scoped so independent discovery runs cannot collide with each other.
--
-- pg_get_functiondef() normalizes the compact source in production as
-- ON CONFLICT(job_id,dedupe_key), so accept both compact and spaced spellings.
-- The migration is also deliberately idempotent: a production database repaired
-- out-of-band may already contain the final target/key when migration history is
-- reconciled later.

DO $$
DECLARE
  v_def TEXT;
  v_has_old_conflict BOOLEAN;
  v_has_new_conflict BOOLEAN;
  v_has_static_marker BOOLEAN;
  v_has_scoped_marker BOOLEAN;
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

  v_has_old_conflict :=
    strpos(v_def, 'ON CONFLICT(job_id,dedupe_key) DO NOTHING') > 0
    OR strpos(v_def, 'ON CONFLICT (job_id, dedupe_key) DO NOTHING') > 0;
  v_has_new_conflict :=
    strpos(v_def, 'ON CONFLICT(dedupe_key) DO NOTHING') > 0
    OR strpos(v_def, 'ON CONFLICT (dedupe_key) DO NOTHING') > 0;
  v_has_static_marker :=
    strpos(v_def, '''stage4.5:pr7:curated-concepts-persisted''') > 0;
  v_has_scoped_marker :=
    strpos(v_def, '''stage4.5:pr7:curated-concepts-persisted:''') > 0;

  IF NOT v_has_old_conflict AND NOT v_has_new_conflict THEN
    RAISE EXCEPTION 'v2 concept persistence function contains neither the expected old nor repaired event conflict target';
  END IF;

  IF NOT v_has_static_marker AND NOT v_has_scoped_marker THEN
    RAISE EXCEPTION 'v2 concept persisted event dedupe marker not found';
  END IF;

  IF v_has_old_conflict THEN
    v_def := replace(
      v_def,
      'ON CONFLICT(job_id,dedupe_key) DO NOTHING',
      'ON CONFLICT(dedupe_key) DO NOTHING'
    );
    v_def := replace(
      v_def,
      'ON CONFLICT (job_id, dedupe_key) DO NOTHING',
      'ON CONFLICT(dedupe_key) DO NOTHING'
    );
  END IF;

  IF v_has_static_marker THEN
    v_def := replace(
      v_def,
      '''stage4.5:pr7:curated-concepts-persisted''',
      '''stage4.5:pr7:curated-concepts-persisted:'' || v_job_id::TEXT'
    );
  END IF;

  IF v_has_old_conflict OR v_has_static_marker THEN
    EXECUTE v_def;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.orchestrator_persist_game_discovery_v2_concepts(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orchestrator_persist_game_discovery_v2_concepts(JSONB)
  TO service_role;
