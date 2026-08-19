-- Gameplay Reference Drive Auto-Sync v1.
-- Manual Drive uploads need no external source URL supplied by a human.
-- Drive stores media; Supabase stores ingest state and durable indexing jobs.

ALTER TABLE public.gameplay_references
  DROP CONSTRAINT IF EXISTS gameplay_references_source_type_check;

ALTER TABLE public.gameplay_references
  ADD CONSTRAINT gameplay_references_source_type_check CHECK (
    source_type IN (
      'official_steam_screenshot',
      'developer_gameplay',
      'official_gameplay_trailer',
      'developer_youtube',
      'gameplay_capture',
      'manual_drive_upload',
      'other'
    )
  );

CREATE TABLE IF NOT EXISTS public.gameplay_reference_drive_ingest (
  drive_file_id TEXT PRIMARY KEY,
  game_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'registered',
      'already_registered',
      'exact_duplicate',
      'unsupported',
      'failed'
    )
  ),
  reference_id TEXT REFERENCES public.gameplay_references(reference_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  canonical_reference_id TEXT REFERENCES public.gameplay_references(reference_id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  content_sha256 TEXT,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gameplay_reference_drive_ingest_file_id_nonempty
    CHECK (length(trim(drive_file_id)) > 0),
  CONSTRAINT gameplay_reference_drive_ingest_game_name_nonempty
    CHECK (length(trim(game_name)) > 0),
  CONSTRAINT gameplay_reference_drive_ingest_filename_nonempty
    CHECK (length(trim(filename)) > 0),
  CONSTRAINT gameplay_reference_drive_ingest_sha256_shape
    CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9A-Fa-f]{64}$')
);

CREATE INDEX IF NOT EXISTS gameplay_reference_drive_ingest_status_idx
  ON public.gameplay_reference_drive_ingest (status, updated_at);

ALTER TABLE public.gameplay_reference_drive_ingest ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gameplay_reference_drive_ingest FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.gameplay_reference_drive_ingest TO service_role;

COMMENT ON TABLE public.gameplay_reference_drive_ingest IS
  'Idempotent scan ledger for media manually dropped into Gameplay Reference Google Drive folders.';

CREATE OR REPLACE FUNCTION public.gameplay_reference_enqueue_index_v1(p_reference_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status TEXT;
  v_job_id UUID;
  v_existing_job_id UUID;
  v_user_id UUID;
  v_enqueue JSONB;
BEGIN
  IF p_reference_id IS NULL OR length(trim(p_reference_id)) = 0 THEN
    RAISE EXCEPTION 'reference id is required';
  END IF;

  SELECT index_status
  INTO v_status
  FROM public.gameplay_references
  WHERE reference_id = p_reference_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('enqueued', false, 'reason', 'reference_not_found');
  END IF;

  IF v_status <> 'pending_caption' THEN
    RETURN jsonb_build_object(
      'enqueued', false,
      'reason', 'reference_not_pending',
      'index_status', v_status
    );
  END IF;

  SELECT id
  INTO v_existing_job_id
  FROM public.factory_jobs
  WHERE workflow_kind = 'gameplay_reference_index'
    AND input->>'reference_id' = p_reference_id
    AND status IN ('queued', 'running', 'waiting', 'retrying')
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_existing_job_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'enqueued', false,
      'reason', 'active_job_exists',
      'job_id', v_existing_job_id
    );
  END IF;

  SELECT created_by
  INTO v_user_id
  FROM public.projects
  WHERE status = 'active'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_user_id IS NULL THEN
    SELECT id INTO v_user_id FROM public.profiles ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'no factory user available for system indexing job';
  END IF;

  INSERT INTO public.factory_jobs (
    request_id,
    user_id,
    status,
    current_stage,
    progress,
    workflow_kind,
    workflow_version,
    input,
    state,
    state_reason
  )
  VALUES (
    gen_random_uuid(),
    v_user_id,
    'queued',
    'queued',
    0,
    'gameplay_reference_index',
    1,
    jsonb_build_object(
      'reference_id', p_reference_id,
      'trigger', 'drive_auto_sync'
    ),
    jsonb_build_object('reference_id', p_reference_id),
    'gameplay_reference_drive_auto_sync'
  )
  RETURNING id INTO v_job_id;

  SELECT public.orchestrator_enqueue(
    v_job_id,
    'gameplay_reference_drive_auto_sync',
    gen_random_uuid(),
    0
  ) INTO v_enqueue;

  RETURN jsonb_build_object(
    'enqueued', COALESCE((v_enqueue->>'enqueued')::BOOLEAN, false),
    'reason', COALESCE(v_enqueue->>'reason', 'queued'),
    'job_id', v_job_id,
    'queue', v_enqueue
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.gameplay_reference_enqueue_index_v1(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gameplay_reference_enqueue_index_v1(TEXT)
  TO service_role;
