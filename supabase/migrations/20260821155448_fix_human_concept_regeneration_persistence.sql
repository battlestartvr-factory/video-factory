-- Restore the workflow-event dedupe contract used by human concept regeneration.
-- Production factory_workflow_events is globally unique on dedupe_key; later Stage 4.5
-- compatibility code accidentally restored the obsolete (job_id, dedupe_key) target.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.orchestrator_persist_game_concept_exploration(jsonb)'::regprocedure)
  INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'orchestrator_persist_game_concept_exploration(jsonb) not found';
  END IF;

  IF position('ON CONFLICT (job_id, dedupe_key) DO NOTHING' in v_def) > 0 THEN
    v_def := replace(
      v_def,
      'ON CONFLICT (job_id, dedupe_key) DO NOTHING',
      'ON CONFLICT (dedupe_key) DO NOTHING'
    );
  END IF;

  IF position('''stage4:s4-003:concepts-persisted''' in v_def) > 0 THEN
    v_def := replace(
      v_def,
      '''stage4:s4-003:concepts-persisted''',
      '''stage4:s4-003:concepts-persisted:'' || v_job_id::TEXT'
    );
  END IF;

  IF position('ON CONFLICT (job_id, dedupe_key) DO NOTHING' in v_def) > 0 THEN
    RAISE EXCEPTION 'obsolete workflow event conflict target is still present';
  END IF;
  IF position('''stage4:s4-003:concepts-persisted:'' || v_job_id::TEXT' in v_def) = 0 THEN
    RAISE EXCEPTION 'concept persistence event key is not job-scoped';
  END IF;

  EXECUTE v_def;
END $$;

UPDATE public.deployment_schema_contract
SET schema_version = '20260821155448',
    updated_at = NOW()
WHERE singleton = TRUE;
