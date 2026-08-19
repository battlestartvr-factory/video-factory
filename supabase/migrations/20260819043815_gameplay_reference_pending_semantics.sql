-- Preserve unknown-vs-false semantics while raw gameplay references await captioning.

ALTER TABLE public.gameplay_references
  ALTER COLUMN teammate_count_visible DROP DEFAULT,
  ALTER COLUMN teammate_count_visible DROP NOT NULL,
  ALTER COLUMN coop_dependency_visible DROP DEFAULT,
  ALTER COLUMN coop_dependency_visible DROP NOT NULL,
  ALTER COLUMN shared_object_visible DROP DEFAULT,
  ALTER COLUMN shared_object_visible DROP NOT NULL,
  ALTER COLUMN information_asymmetry_visible DROP DEFAULT,
  ALTER COLUMN information_asymmetry_visible DROP NOT NULL,
  ALTER COLUMN rescue_visible DROP DEFAULT,
  ALTER COLUMN rescue_visible DROP NOT NULL,
  ALTER COLUMN coordination_visible DROP DEFAULT,
  ALTER COLUMN coordination_visible DROP NOT NULL,
  ALTER COLUMN core_action DROP NOT NULL,
  ALTER COLUMN primary_focus DROP NOT NULL;

ALTER TABLE public.gameplay_references
  DROP CONSTRAINT IF EXISTS gameplay_references_indexed_metadata_complete;

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
      AND teammate_count_visible IS NOT NULL
      AND coop_dependency_visible IS NOT NULL
      AND shared_object_visible IS NOT NULL
      AND information_asymmetry_visible IS NOT NULL
      AND rescue_visible IS NOT NULL
      AND coordination_visible IS NOT NULL
      AND core_action IS NOT NULL
      AND primary_focus IS NOT NULL
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

COMMENT ON COLUMN public.gameplay_references.coop_dependency_visible IS
  'NULL while pending captioning; true/false only after structured gameplay analysis.';
COMMENT ON COLUMN public.gameplay_references.teammate_count_visible IS
  'NULL while pending captioning; concrete count only after structured gameplay analysis.';
