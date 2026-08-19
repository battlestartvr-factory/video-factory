-- A gameplay-reference caption is a paid/externally visible side effect. A stale worker lease
-- must never be allowed to repeat that side effect after an ambiguous crash/redeploy.
--
-- The permit is deliberately fail-closed: pending_caption -> captioning is atomic and one-way
-- until the current attempt either persists indexed/failed evidence or an operator explicitly
-- investigates and resets the row. There is no automatic timeout reset for captioning.

ALTER TABLE public.gameplay_references
  ADD COLUMN IF NOT EXISTS caption_attempt_id UUID,
  ADD COLUMN IF NOT EXISTS caption_started_at TIMESTAMPTZ;

ALTER TABLE public.gameplay_references
  DROP CONSTRAINT IF EXISTS gameplay_references_index_status_valid;
ALTER TABLE public.gameplay_references
  ADD CONSTRAINT gameplay_references_index_status_valid
  CHECK (index_status IN ('pending_caption', 'captioning', 'indexed', 'failed'));

ALTER TABLE public.gameplay_references
  DROP CONSTRAINT IF EXISTS gameplay_references_captioning_attempt_complete;
ALTER TABLE public.gameplay_references
  ADD CONSTRAINT gameplay_references_captioning_attempt_complete
  CHECK (
    index_status <> 'captioning'
    OR (caption_attempt_id IS NOT NULL AND caption_started_at IS NOT NULL)
  );

COMMENT ON COLUMN public.gameplay_references.caption_attempt_id IS
  'Durable single-call permit identity for the external caption attempt. Preserved after completion for audit/debugging.';
COMMENT ON COLUMN public.gameplay_references.caption_started_at IS
  'Timestamp when pending_caption atomically transitioned to captioning. captioning is never auto-reset after an ambiguous crash.';

CREATE OR REPLACE FUNCTION public.gameplay_reference_claim_caption_attempt_v1(
  p_reference_id TEXT,
  p_attempt_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reference_id TEXT;
  v_status TEXT;
  v_attempt_id UUID;
  v_started_at TIMESTAMPTZ;
BEGIN
  IF p_reference_id IS NULL OR length(trim(p_reference_id)) = 0 THEN
    RAISE EXCEPTION 'reference_id is required';
  END IF;
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'attempt_id is required';
  END IF;

  UPDATE public.gameplay_references
  SET
    index_status = 'captioning',
    caption_attempt_id = p_attempt_id,
    caption_started_at = NOW(),
    index_error = NULL,
    updated_at = NOW()
  WHERE reference_id = trim(p_reference_id)
    AND index_status = 'pending_caption'
  RETURNING reference_id, index_status, caption_attempt_id, caption_started_at
  INTO v_reference_id, v_status, v_attempt_id, v_started_at;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'claimed', true,
      'reference_id', v_reference_id,
      'status', v_status,
      'attempt_id', v_attempt_id,
      'started_at', v_started_at
    );
  END IF;

  SELECT reference_id, index_status, caption_attempt_id, caption_started_at
  INTO v_reference_id, v_status, v_attempt_id, v_started_at
  FROM public.gameplay_references
  WHERE reference_id = trim(p_reference_id);

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reference_id', trim(p_reference_id),
      'reason', 'not_found'
    );
  END IF;

  RETURN jsonb_build_object(
    'claimed', false,
    'reference_id', v_reference_id,
    'reason', 'not_pending',
    'status', v_status,
    'existing_attempt_id', v_attempt_id,
    'started_at', v_started_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.gameplay_reference_claim_caption_attempt_v1(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gameplay_reference_claim_caption_attempt_v1(TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.gameplay_reference_claim_caption_attempt_v1(TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.gameplay_reference_claim_caption_attempt_v1(TEXT, UUID) TO service_role;
