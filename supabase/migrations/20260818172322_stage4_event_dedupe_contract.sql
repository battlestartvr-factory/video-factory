-- Stage 4 event writers were introduced with a composite ON CONFLICT target,
-- while factory_workflow_events intentionally owns a global UNIQUE(dedupe_key)
-- contract. PostgreSQL rejects a conflict target that has no matching unique
-- constraint before the insert can run, which made concept persistence roll back
-- after the paid LLM generation had already completed.
--
-- Keep the established global event idempotency contract. Patch only the Stage 4
-- functions that accidentally targeted (job_id, dedupe_key), and qualify the one
-- static Stage 4 concept event key with the job id so independent batches do not
-- collide globally.

DO $$
DECLARE
  v_name TEXT;
  v_def TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'orchestrator_finalize_gameplay_discovery_batch',
    'orchestrator_persist_game_concept_exploration',
    'orchestrator_persist_gameplay_assembly',
    'orchestrator_persist_gameplay_asset_graph',
    'orchestrator_record_gameplay_reference_review'
  ]
  LOOP
    SELECT pg_get_functiondef(p.oid)
      INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname = v_name
    ORDER BY p.oid
    LIMIT 1;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'required Stage 4 function % not found', v_name;
    END IF;

    IF strpos(v_def, 'ON CONFLICT (job_id, dedupe_key) DO NOTHING') = 0 THEN
      RAISE EXCEPTION 'Stage 4 function % does not contain the expected composite event conflict target', v_name;
    END IF;

    v_def := replace(
      v_def,
      'ON CONFLICT (job_id, dedupe_key) DO NOTHING',
      'ON CONFLICT (dedupe_key) DO NOTHING'
    );

    IF v_name = 'orchestrator_persist_game_concept_exploration' THEN
      IF strpos(v_def, '''stage4:s4-003:concepts-persisted''') = 0 THEN
        RAISE EXCEPTION 'concept exploration event dedupe key marker not found';
      END IF;

      v_def := replace(
        v_def,
        '''stage4:s4-003:concepts-persisted''',
        '''stage4:s4-003:concepts-persisted:'' || v_job_id::TEXT'
      );
    END IF;

    EXECUTE v_def;
  END LOOP;
END
$$;
