-- Generated-asset Gameplay Authenticity Inspector evidence.
-- One deterministic inspection record per generated asset/kind; service_role only.

CREATE TABLE IF NOT EXISTS public.gameplay_authenticity_inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_creative_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL REFERENCES public.generations(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  moment_id TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('image', 'video')),
  inspection_kind TEXT NOT NULL,
  inspector_model TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  average_score REAL NOT NULL CHECK (average_score BETWEEN 0 AND 1),
  hard_failures TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  inspection JSONB NOT NULL,
  usage JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gameplay_auth_inspection_shot_nonempty CHECK (length(trim(shot_id)) > 0),
  CONSTRAINT gameplay_auth_inspection_kind_nonempty CHECK (length(trim(inspection_kind)) > 0),
  CONSTRAINT gameplay_auth_inspection_model_nonempty CHECK (length(trim(inspector_model)) > 0),
  UNIQUE (generation_id, inspection_kind)
);

CREATE INDEX IF NOT EXISTS gameplay_auth_inspection_root_idx
  ON public.gameplay_authenticity_inspections (root_creative_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gameplay_auth_inspection_shot_idx
  ON public.gameplay_authenticity_inspections (shot_id, asset_type, created_at DESC);
CREATE INDEX IF NOT EXISTS gameplay_auth_inspection_failed_idx
  ON public.gameplay_authenticity_inspections (asset_type, passed, created_at DESC);

ALTER TABLE public.gameplay_authenticity_inspections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gameplay_authenticity_inspections FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.gameplay_authenticity_inspections TO service_role;

COMMENT ON TABLE public.gameplay_authenticity_inspections IS
  'Cheap vision inspection evidence for generated Stage 4 gameplay reference images and sampled gameplay videos before human/assembly gates.';
