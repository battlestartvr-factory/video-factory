-- Human-facing UI and planning may be Russian, but readable text rendered inside
-- generated gameplay images/videos must be English-only. Enforce this at the final
-- paid media admission boundary so compiler drift cannot silently remove the rule.
DO $$
DECLARE
  v_image_def TEXT;
  v_video_def TEXT;
  v_image_anchor TEXT := E'  IF jsonb_array_length(v_reference_assets) <> jsonb_array_length(v_reference_lineage) THEN\n    RAISE EXCEPTION ''reference_assets and reference_lineage counts must match'';\n  END IF;\n\n  SELECT * INTO v_root';
  v_image_replacement TEXT := E'  IF jsonb_array_length(v_reference_assets) <> jsonb_array_length(v_reference_lineage) THEN\n    RAISE EXCEPTION ''reference_assets and reference_lineage counts must match'';\n  END IF;\n\n  v_prompt := v_prompt || E''\\n\\nVISIBLE TEXT POLICY: If any readable text appears inside the generated image (HUD, UI, signs, captions, player names, button prompts, labels, overlays), it MUST be English only. Never render Russian or Cyrillic text.'';\n\n  SELECT * INTO v_root';
  v_video_anchor TEXT := E'  IF v_video_prompt IS NULL THEN RAISE EXCEPTION ''video prompt is missing for approved shot''; END IF;';
  v_video_replacement TEXT := E'  IF v_video_prompt IS NULL THEN RAISE EXCEPTION ''video prompt is missing for approved shot''; END IF;\n  v_video_prompt := v_video_prompt || E''\\n\\nVISIBLE TEXT POLICY: If any readable text appears in any video frame (HUD, UI, signs, captions, player names, button prompts, labels, overlays), it MUST be English only. Never render Russian or Cyrillic text.'';';
BEGIN
  SELECT pg_get_functiondef('public.orchestrator_create_gameplay_reference_image(jsonb)'::regprocedure)
  INTO v_image_def;
  SELECT pg_get_functiondef('public.orchestrator_create_approved_gameplay_video(jsonb)'::regprocedure)
  INTO v_video_def;

  IF v_image_def IS NULL OR v_video_def IS NULL THEN
    RAISE EXCEPTION 'Stage 4 media admission functions are missing';
  END IF;

  IF position('VISIBLE TEXT POLICY:' in v_image_def) = 0 THEN
    IF position(v_image_anchor in v_image_def) = 0 THEN
      RAISE EXCEPTION 'reference-image admission anchor not found';
    END IF;
    v_image_def := replace(v_image_def, v_image_anchor, v_image_replacement);
    EXECUTE v_image_def;
  END IF;

  IF position('VISIBLE TEXT POLICY:' in v_video_def) = 0 THEN
    IF position(v_video_anchor in v_video_def) = 0 THEN
      RAISE EXCEPTION 'gameplay-video admission anchor not found';
    END IF;
    v_video_def := replace(v_video_def, v_video_anchor, v_video_replacement);
    EXECUTE v_video_def;
  END IF;

  SELECT pg_get_functiondef('public.orchestrator_create_gameplay_reference_image(jsonb)'::regprocedure)
  INTO v_image_def;
  SELECT pg_get_functiondef('public.orchestrator_create_approved_gameplay_video(jsonb)'::regprocedure)
  INTO v_video_def;

  IF position('MUST be English only' in v_image_def) = 0
     OR position('Never render Russian or Cyrillic text' in v_image_def) = 0
     OR position('MUST be English only' in v_video_def) = 0
     OR position('Never render Russian or Cyrillic text' in v_video_def) = 0 THEN
    RAISE EXCEPTION 'English-only visible-text policy was not installed on both media boundaries';
  END IF;
END $$;

UPDATE public.deployment_schema_contract
SET schema_version = '20260821164000',
    updated_at = NOW()
WHERE singleton = TRUE;