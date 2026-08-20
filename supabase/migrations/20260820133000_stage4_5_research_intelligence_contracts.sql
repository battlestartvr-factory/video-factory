-- Stage 4.5 PR1 — External Intelligence / Research Memory contracts.
-- Additive only: this migration does not alter Stage 4 workflow state, Human Gates,
-- core_orchestrator_v1, or memory_items. Research tables are evidence/index/cache;
-- factory_jobs + creative_runs remain the durable workflow/lineage owners.

CREATE TABLE IF NOT EXISTS public.research_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_job_id UUID NOT NULL REFERENCES public.factory_jobs(id) ON DELETE CASCADE,
  root_creative_run_id UUID NOT NULL REFERENCES public.creative_runs(id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','running','waiting_scouts','synthesizing','completed','failed','cancelled')),
  plan JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(plan) = 'object'),
  budget JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(budget) = 'object'),
  coverage JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(coverage) = 'object'),
  cost JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(cost) = 'object'),
  error JSONB CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT research_runs_terminal_time_check CHECK (
    status NOT IN ('completed','failed','cancelled') OR completed_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_research_runs_factory_job
  ON public.research_runs(factory_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_runs_root_creative_run
  ON public.research_runs(root_creative_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_runs_objective
  ON public.research_runs(objective_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_runs_status
  ON public.research_runs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.research_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  scout_role TEXT NOT NULL CHECK (
    scout_role IN ('market_competitor','mechanics','player_voice','gameplay_visual','white_space_contrarian')
  ),
  query_type TEXT NOT NULL CHECK (query_type IN ('text','image')),
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','running','completed','failed','cached')),
  result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  cache_key TEXT,
  error JSONB CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_research_queries_run_role
  ON public.research_queries(run_id, scout_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_queries_cache_key
  ON public.research_queries(cache_key)
  WHERE cache_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.research_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT 'web_page',
  title TEXT,
  published_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fetched_at TIMESTAMPTZ,
  content_hash TEXT,
  extracted_text TEXT,
  extracted_text_pointer JSONB CHECK (
    extracted_text_pointer IS NULL OR jsonb_typeof(extracted_text_pointer) = 'object'
  ),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_sources_content_hash
  ON public.research_sources(content_hash)
  WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_research_sources_observed_at
  ON public.research_sources(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_sources_text_search
  ON public.research_sources
  USING GIN (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(extracted_text, '')));

CREATE TABLE IF NOT EXISTS public.research_run_sources (
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  scout_role TEXT NOT NULL CHECK (
    scout_role IN ('market_competitor','mechanics','player_voice','gameplay_visual','white_space_contrarian')
  ),
  query_id UUID REFERENCES public.research_queries(id) ON DELETE SET NULL,
  relevance_score DOUBLE PRECISION CHECK (
    relevance_score IS NULL OR (relevance_score >= 0 AND relevance_score <= 1)
  ),
  selected BOOLEAN NOT NULL DEFAULT FALSE,
  reused_from_cache BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, source_id, scout_role)
);

CREATE INDEX IF NOT EXISTS idx_research_run_sources_source
  ON public.research_run_sources(source_id, run_id);
CREATE INDEX IF NOT EXISTS idx_research_run_sources_query
  ON public.research_run_sources(query_id)
  WHERE query_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.research_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  scout_role TEXT NOT NULL CHECK (
    scout_role IN ('market_competitor','mechanics','player_voice','gameplay_visual','white_space_contrarian')
  ),
  evidence_type TEXT NOT NULL CHECK (
    evidence_type IN (
      'market_pattern','mechanic_pattern','player_love','player_pain','saturation_signal',
      'white_space','counterexample','gameplay_reference_pattern','visual_reference_pattern'
    )
  ),
  subject TEXT NOT NULL,
  claim TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  freshness_class TEXT NOT NULL CHECK (freshness_class IN ('fresh','recent','evergreen','unknown')),
  tags JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(tags) = 'array'),
  observed_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_evidence_run_type
  ON public.research_evidence(run_id, evidence_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_evidence_run_role
  ON public.research_evidence(run_id, scout_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_evidence_observed
  ON public.research_evidence(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_evidence_tags
  ON public.research_evidence USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_research_evidence_text_search
  ON public.research_evidence
  USING GIN (to_tsvector('simple', subject || ' ' || claim));

-- Multiple sources can support one atomic claim. A join table keeps provenance
-- referentially valid instead of hiding source IDs in unchecked JSON.
CREATE TABLE IF NOT EXISTS public.research_evidence_sources (
  evidence_id UUID NOT NULL REFERENCES public.research_evidence(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  support_kind TEXT NOT NULL DEFAULT 'support'
    CHECK (support_kind IN ('support','counterexample','context')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (evidence_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_research_evidence_sources_source
  ON public.research_evidence_sources(source_id, evidence_id);

CREATE TABLE IF NOT EXISTS public.research_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL DEFAULT 'image' CHECK (asset_type IN ('image','media')),
  original_url TEXT NOT NULL,
  drive_file_id TEXT,
  mime TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  sha256 TEXT,
  perceptual_hash TEXT,
  roles JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(roles) = 'array'),
  why_relevant TEXT,
  must_not_copy JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(must_not_copy) = 'array'),
  trust TEXT NOT NULL DEFAULT 'normal' CHECK (trust IN ('preferred','normal','low')),
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','selected','archived','rejected','invalid')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_assets_run_status
  ON public.research_assets(run_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_assets_source
  ON public.research_assets(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_assets_sha256
  ON public.research_assets(sha256)
  WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_research_assets_perceptual_hash
  ON public.research_assets(perceptual_hash)
  WHERE perceptual_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_research_assets_run_exact_dedupe
  ON public.research_assets(run_id, sha256)
  WHERE sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.research_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.research_runs(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  pack JSONB NOT NULL CHECK (jsonb_typeof(pack) = 'object'),
  input_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_packs_one_active_per_run
  ON public.research_packs(run_id)
  WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_research_packs_input_hash
  ON public.research_packs(input_hash);

COMMENT ON TABLE public.research_runs IS
  'Stage 4.5 research session metadata. Evidence/index layer only; factory_jobs remains authoritative workflow state.';
COMMENT ON TABLE public.research_sources IS
  'Canonical external sources and bounded extracted evidence/cache pointers. External content is untrusted data.';
COMMENT ON TABLE public.research_evidence IS
  'Atomic source-backed fresh evidence. This is not Stage 6 durable strategic memory.';
COMMENT ON TABLE public.research_assets IS
  'External visual/media reference candidates. Rows are external evidence, never generated factory assets.';
COMMENT ON TABLE public.research_packs IS
  'Versioned bounded Evidence Packs selected from Research Memory for downstream typed consumers.';

-- Stage 4.5 research storage is worker/service-owned in PR1. Product UI access
-- will be added through explicit read surfaces later rather than granting direct
-- client writes to evidence or provenance.
ALTER TABLE public.research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_run_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_evidence_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_packs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.research_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.research_queries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.research_sources FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.research_run_sources FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.research_evidence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.research_evidence_sources FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.research_assets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.research_packs FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.research_runs TO service_role;
GRANT ALL ON TABLE public.research_queries TO service_role;
GRANT ALL ON TABLE public.research_sources TO service_role;
GRANT ALL ON TABLE public.research_run_sources TO service_role;
GRANT ALL ON TABLE public.research_evidence TO service_role;
GRANT ALL ON TABLE public.research_evidence_sources TO service_role;
GRANT ALL ON TABLE public.research_assets TO service_role;
GRANT ALL ON TABLE public.research_packs TO service_role;
