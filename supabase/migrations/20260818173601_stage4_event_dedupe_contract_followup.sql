-- Follow-up audit found six additional Stage 4 event writers using the same
-- invalid composite ON CONFLICT target. Keep factory_workflow_events on its
-- established global UNIQUE(dedupe_key) contract and make static Stage 4 keys
-- job-qualified where necessary.

DO $$
DECLARE
  v_name TEXT;
  v_def TEXT;
  v_before TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'orchestrator_create_approved_gameplay_video',
    'orchestrator_create_gameplay_reference_image',
    'orchestrator_persist_game_pre_evaluations',
    'orchestrator_persist_gameplay_moments',
    'orchestrator_persist_gameplay_shots_and_prompts',
    'orchestrator_prepare_gameplay_reference_revision'
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

    v_before := v_def;
    v_def := replace(v_def, 'ON CONFLICT (job_id,dedupe_key) DO NOTHING', 'ON CONFLICT (dedupe_key) DO NOTHING');
    v_def := replace(v_def, 'ON CONFLICT(job_id,dedupe_key) DO NOTHING', 'ON CONFLICT(dedupe_key) DO NOTHING');
    v_def := replace(v_def, 'ON CONFLICT (job_id, dedupe_key) DO NOTHING', 'ON CONFLICT (dedupe_key) DO NOTHING');
    v_def := replace(v_def, 'ON CONFLICT(job_id, dedupe_key) DO NOTHING', 'ON CONFLICT(dedupe_key) DO NOTHING');

    IF v_def = v_before THEN
      RAISE EXCEPTION 'Stage 4 function % does not contain the expected composite event conflict target', v_name;
    END IF;

    IF v_name = 'orchestrator_persist_game_pre_evaluations' THEN
      IF strpos(v_def, '''stage4:s4-004:pre-evaluations-persisted''') = 0 THEN
        RAISE EXCEPTION 'pre-evaluation event dedupe key marker not found';
      END IF;
      v_def := replace(
        v_def,
        '''stage4:s4-004:pre-evaluations-persisted''',
        '''stage4:s4-004:pre-evaluations-persisted:'' || v_job_id::TEXT'
      );
    ELSIF v_name = 'orchestrator_persist_gameplay_moments' THEN
      IF strpos(v_def, '''stage4:s4-004:gameplay-moments-persisted''') = 0 THEN
        RAISE EXCEPTION 'gameplay-moment event dedupe key marker not found';
      END IF;
      v_def := replace(
        v_def,
        '''stage4:s4-004:gameplay-moments-persisted''',
        '''stage4:s4-004:gameplay-moments-persisted:'' || v_job_id::TEXT'
      );
    ELSIF v_name = 'orchestrator_persist_gameplay_shots_and_prompts' THEN
      IF strpos(v_def, '''stage4:s4-004:shots-prompts-persisted''') = 0 THEN
        RAISE EXCEPTION 'shots/prompts initial event dedupe key marker not found';
      END IF;
      v_def := replace(
        v_def,
        '''stage4:s4-004:shots-prompts-persisted''',
        '''stage4:s4-004:shots-prompts-persisted:'' || v_job_id::TEXT'
      );
      v_def := replace(
        v_def,
        '''stage4:s4-004:shots-prompts-persisted:revision:''||v_revision_key',
        '''stage4:s4-004:shots-prompts-persisted:revision:''||v_job_id::TEXT||'':''||v_revision_key'
      );
    ELSIF v_name = 'orchestrator_prepare_gameplay_reference_revision' THEN
      IF strpos(v_def, '''stage4:reference-revision:''||v_revision_key') = 0 THEN
        RAISE EXCEPTION 'reference revision event dedupe key marker not found';
      END IF;
      v_def := replace(
        v_def,
        '''stage4:reference-revision:''||v_revision_key',
        '''stage4:reference-revision:''||v_root.factory_job_id::TEXT||'':''||v_revision_key'
      );
    END IF;

    EXECUTE v_def;
  END LOOP;
END
$$;
