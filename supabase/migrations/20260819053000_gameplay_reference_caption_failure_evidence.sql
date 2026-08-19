ALTER TABLE public.gameplay_references
  ADD COLUMN IF NOT EXISTS caption_debug JSONB NOT NULL DEFAULT '{}'::JSONB;

COMMENT ON COLUMN public.gameplay_references.caption_debug IS
  'Bounded cheap-caption diagnostic evidence such as raw model output and schema validation errors. Never used as source of truth for indexed gameplay metadata.';
