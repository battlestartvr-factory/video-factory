-- Gameplay Reference Library v1 / staged ingest lifecycle.
-- Raw media/provenance can land before cheap multimodal captioning. Retrieval may only use indexed rows.

ALTER TABLE public.gameplay_references
  ADD COLUMN IF NOT EXISTS index_status TEXT NOT NULL DEFAULT 'pending_caption',
  ADD COLUMN IF NOT EXISTS index_error TEXT,
  ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS caption_model TEXT,
  ADD COLUMN IF NOT EXISTS caption_usage JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE public.gameplay_references
  ADD CONSTRAINT gameplay_references_index_status_valid
  CHECK (index_status IN ('pending_caption', 'indexed', 'failed'));

ALTER TABLE public.gameplay_references
  ALTER COLUMN camera_type DROP NOT NULL,
  ALTER COLUMN controllable_player_obvious DROP NOT NULL,
  ALTER COLUMN how_player_control_is_visible DROP NOT NULL,
  ALTER COLUMN current_player_action DROP NOT NULL,
  ALTER COLUMN visible_input_affordance DROP NOT NULL,
  ALTER COLUMN game_response DROP NOT NULL,
  ALTER COLUMN readable_without_context DROP NOT NULL,
  ALTER COLUMN visible_goal DROP NOT NULL,
  ALTER COLUMN visible_risk DROP NOT NULL,
  ALTER COLUMN ui_supports_action DROP NOT NULL,
  ALTER COLUMN visual_clutter DROP NOT NULL,
  ALTER COLUMN art_direction DROP NOT NULL,
  ALTER COLUMN realism_level DROP NOT NULL,
  ALTER COLUMN production_scope_feel DROP NOT NULL,
  ALTER COLUMN gameplay_description DROP NOT NULL,
  ALTER COLUMN why_this_looks_like_gameplay DROP NOT NULL;

ALTER TABLE public.gameplay_references
  ADD CONSTRAINT gameplay_references_indexed_metadata_complete
  CHECK (
    index_status <> 'indexed'
    OR (
      camera_type IS NOT NULL
      AND controllable_player_obvious IS NOT NULL
      AND how_player_control_is_visible IS NOT NULL
      AND current_player_action IS NOT NULL
      AND visible_input_affordance IS NOT NULL
      AND game_response IS NOT NULL
      AND readable_without_context IS NOT NULL
      AND visible_goal IS NOT NULL
      AND visible_risk IS NOT NULL
      AND ui_supports_action IS NOT NULL
      AND visual_clutter IS NOT NULL
      AND art_direction IS NOT NULL
      AND realism_level IS NOT NULL
      AND production_scope_feel IS NOT NULL
      AND gameplay_description IS NOT NULL
      AND why_this_looks_like_gameplay IS NOT NULL
      AND indexed_at IS NOT NULL
    )
  );

ALTER TABLE public.gameplay_references
  DROP CONSTRAINT IF EXISTS gameplay_references_embedding_dimensions_matches_storage;
ALTER TABLE public.gameplay_references
  ADD CONSTRAINT gameplay_references_embedding_dimensions_matches_storage
  CHECK (embedding_dimensions IS NULL OR embedding_dimensions = 768);

CREATE INDEX IF NOT EXISTS gameplay_references_index_status_idx
  ON public.gameplay_references (index_status, game_id, media_type);

COMMENT ON COLUMN public.gameplay_references.index_status IS
  'Ingest lifecycle: raw media/provenance may be stored as pending_caption; only indexed rows are eligible for retrieval.';
COMMENT ON COLUMN public.gameplay_references.caption_usage IS
  'Cheap multimodal caption/index usage accounting; deterministic normalization does not require a second model call.';
