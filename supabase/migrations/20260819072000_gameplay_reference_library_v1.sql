-- Gameplay Reference Library v1 / foundation.
-- Large media stays in Google Drive. Postgres stores provenance, searchable gameplay grammar,
-- dedupe signals, embeddings and durable Drive pointers.

CREATE TABLE IF NOT EXISTS public.gameplay_reference_games (
  game_id TEXT PRIMARY KEY,
  game_name TEXT NOT NULL,
  steam_app_id BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gameplay_reference_games_game_id_nonempty CHECK (length(trim(game_id)) > 0),
  CONSTRAINT gameplay_reference_games_name_nonempty CHECK (length(trim(game_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS gameplay_reference_games_name_unique
  ON public.gameplay_reference_games (lower(game_name));

CREATE TABLE IF NOT EXISTS public.gameplay_references (
  reference_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  game_id TEXT NOT NULL REFERENCES public.gameplay_reference_games(game_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  game_name TEXT NOT NULL,

  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video_segment')),
  source_type TEXT NOT NULL CHECK (
    source_type IN (
      'official_steam_screenshot',
      'developer_gameplay',
      'official_gameplay_trailer',
      'developer_youtube',
      'gameplay_capture',
      'other'
    )
  ),
  source_url TEXT NOT NULL,
  source_timestamp_ms BIGINT CHECK (source_timestamp_ms IS NULL OR source_timestamp_ms >= 0),
  captured_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  drive_file_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms > 0),

  camera_type TEXT NOT NULL CHECK (
    camera_type IN (
      'first_person',
      'third_person_follow',
      'over_shoulder',
      'top_down',
      'fixed_gameplay',
      'other'
    )
  ),
  camera_distance TEXT,
  camera_height TEXT,
  fov_estimate REAL CHECK (fov_estimate IS NULL OR (fov_estimate > 0 AND fov_estimate <= 180)),
  playable_character_visible BOOLEAN,
  hands_visible BOOLEAN,
  held_tool_visible BOOLEAN,
  crosshair_visible BOOLEAN,
  hud_visible BOOLEAN,

  controllable_player_obvious BOOLEAN NOT NULL,
  how_player_control_is_visible TEXT NOT NULL,
  current_player_action TEXT NOT NULL,
  visible_input_affordance TEXT NOT NULL,
  player_target TEXT,
  game_response TEXT NOT NULL,

  teammate_count_visible INTEGER NOT NULL DEFAULT 0 CHECK (teammate_count_visible BETWEEN 0 AND 16),
  teammate_distance TEXT,
  teammate_role TEXT,
  coop_dependency_visible BOOLEAN NOT NULL DEFAULT false,
  shared_object_visible BOOLEAN NOT NULL DEFAULT false,
  information_asymmetry_visible BOOLEAN NOT NULL DEFAULT false,
  rescue_visible BOOLEAN NOT NULL DEFAULT false,
  coordination_visible BOOLEAN NOT NULL DEFAULT false,

  core_action TEXT NOT NULL,
  mechanic_tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  interaction_model TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  danger_source TEXT,
  failure_risk TEXT,
  success_state TEXT,
  physics_interaction TEXT,
  environment_type TEXT,

  primary_focus TEXT NOT NULL,
  secondary_focus TEXT,
  readable_without_context BOOLEAN NOT NULL,
  visible_goal BOOLEAN NOT NULL,
  visible_risk BOOLEAN NOT NULL,
  ui_supports_action BOOLEAN NOT NULL,
  visual_clutter TEXT NOT NULL CHECK (visual_clutter IN ('low', 'medium', 'high')),

  art_direction TEXT NOT NULL,
  realism_level TEXT NOT NULL,
  production_scope_feel TEXT NOT NULL CHECK (production_scope_feel IN ('indie', 'AA', 'AAA')),
  stylization_tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],

  gameplay_description TEXT NOT NULL,
  why_this_looks_like_gameplay TEXT NOT NULL,

  content_sha256 TEXT,
  perceptual_hash TEXT,
  embedding public.vector(768),
  embedding_model TEXT,
  embedding_dimensions INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions > 0),
  canonical_reference_id TEXT REFERENCES public.gameplay_references(reference_id) ON UPDATE CASCADE ON DELETE SET NULL,
  dedupe_reason TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT gameplay_references_reference_id_nonempty CHECK (length(trim(reference_id)) > 0),
  CONSTRAINT gameplay_references_drive_file_id_nonempty CHECK (length(trim(drive_file_id)) > 0),
  CONSTRAINT gameplay_references_source_url_nonempty CHECK (length(trim(source_url)) > 0),
  CONSTRAINT gameplay_references_media_duration_consistent CHECK (
    (media_type = 'image' AND duration_ms IS NULL)
    OR
    (media_type = 'video_segment' AND duration_ms IS NOT NULL)
  ),
  CONSTRAINT gameplay_references_canonical_not_self CHECK (
    canonical_reference_id IS NULL OR canonical_reference_id <> reference_id
  ),
  CONSTRAINT gameplay_references_sha256_shape CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[0-9A-Fa-f]{64}$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS gameplay_references_drive_file_unique
  ON public.gameplay_references (drive_file_id);

CREATE UNIQUE INDEX IF NOT EXISTS gameplay_references_exact_hash_unique
  ON public.gameplay_references (content_sha256)
  WHERE content_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS gameplay_references_game_camera_idx
  ON public.gameplay_references (game_id, camera_type, media_type);

CREATE INDEX IF NOT EXISTS gameplay_references_camera_gameplay_idx
  ON public.gameplay_references (camera_type, controllable_player_obvious, readable_without_context);

CREATE INDEX IF NOT EXISTS gameplay_references_canonical_idx
  ON public.gameplay_references (canonical_reference_id);

CREATE INDEX IF NOT EXISTS gameplay_references_mechanic_tags_gin
  ON public.gameplay_references USING GIN (mechanic_tags);

CREATE INDEX IF NOT EXISTS gameplay_references_interaction_model_gin
  ON public.gameplay_references USING GIN (interaction_model);

CREATE INDEX IF NOT EXISTS gameplay_references_stylization_tags_gin
  ON public.gameplay_references USING GIN (stylization_tags);

ALTER TABLE public.gameplay_reference_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gameplay_references ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.gameplay_reference_games FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.gameplay_references FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.gameplay_reference_games TO service_role;
GRANT ALL ON TABLE public.gameplay_references TO service_role;

COMMENT ON TABLE public.gameplay_reference_games IS
  'Stable game identities for Gameplay Reference Library media stored in Google Drive.';

COMMENT ON TABLE public.gameplay_references IS
  'Structured gameplay grammar, provenance, Drive pointers, dedupe signals and embeddings for real gameplay references; never stores raw media blobs.';

COMMENT ON COLUMN public.gameplay_references.embedding IS
  '768-dimension semantic embedding used by the later hybrid Gameplay Reference Retriever.';

COMMENT ON COLUMN public.gameplay_references.canonical_reference_id IS
  'Near-duplicate pointer. NULL means this row is canonical; non-NULL points to the canonical reference.';
