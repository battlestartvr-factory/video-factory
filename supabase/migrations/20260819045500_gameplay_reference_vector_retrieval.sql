-- Vector-ready retrieval primitive for Gameplay Reference Library v1.
-- Metadata filtering stays deterministic SQL; application code performs purpose labeling
-- and diversity reranking over this bounded candidate set.

CREATE INDEX IF NOT EXISTS gameplay_references_embedding_hnsw
  ON public.gameplay_references
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL
    AND canonical_reference_id IS NULL
    AND index_status = 'indexed';

CREATE OR REPLACE FUNCTION public.match_gameplay_references_v1(
  p_query_embedding public.vector(768),
  p_match_count INTEGER DEFAULT 40,
  p_camera_types TEXT[] DEFAULT NULL,
  p_production_scopes TEXT[] DEFAULT NULL,
  p_require_coop BOOLEAN DEFAULT NULL,
  p_require_shared_object BOOLEAN DEFAULT NULL,
  p_require_visible_risk BOOLEAN DEFAULT NULL,
  p_mechanic_tags TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  reference_id TEXT,
  semantic_similarity REAL
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.reference_id,
    (1 - (r.embedding <=> p_query_embedding))::REAL AS semantic_similarity
  FROM public.gameplay_references AS r
  WHERE p_query_embedding IS NOT NULL
    AND r.index_status = 'indexed'
    AND r.embedding IS NOT NULL
    AND r.canonical_reference_id IS NULL
    AND (p_camera_types IS NULL OR r.camera_type = ANY(p_camera_types))
    AND (p_production_scopes IS NULL OR r.production_scope_feel = ANY(p_production_scopes))
    AND (p_require_coop IS NULL OR r.coop_dependency_visible = p_require_coop)
    AND (p_require_shared_object IS NULL OR r.shared_object_visible = p_require_shared_object)
    AND (p_require_visible_risk IS NULL OR r.visible_risk = p_require_visible_risk)
    AND (p_mechanic_tags IS NULL OR r.mechanic_tags && p_mechanic_tags)
  ORDER BY r.embedding <=> p_query_embedding
  LIMIT LEAST(GREATEST(COALESCE(p_match_count, 40), 1), 120);
$$;

REVOKE ALL ON FUNCTION public.match_gameplay_references_v1(
  public.vector(768), INTEGER, TEXT[], TEXT[], BOOLEAN, BOOLEAN, BOOLEAN, TEXT[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_gameplay_references_v1(
  public.vector(768), INTEGER, TEXT[], TEXT[], BOOLEAN, BOOLEAN, BOOLEAN, TEXT[]
) TO service_role;

COMMENT ON FUNCTION public.match_gameplay_references_v1(
  public.vector(768), INTEGER, TEXT[], TEXT[], BOOLEAN, BOOLEAN, BOOLEAN, TEXT[]
) IS 'Bounded semantic candidate retrieval for indexed canonical gameplay references; purpose labeling and diversity reranking happen in typed application code.';
