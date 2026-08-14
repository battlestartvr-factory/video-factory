-- Knowledge Base: Drive metadata, extended statuses, full-text search
-- Additive only — safe to apply on existing deployments

-- ---------------------------------------------------------------------------
-- Extend knowledge_documents status values and Drive metadata
-- ---------------------------------------------------------------------------
ALTER TABLE public.knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_status_check;

ALTER TABLE public.knowledge_documents
  ADD CONSTRAINT knowledge_documents_status_check
  CHECK (status IN (
    'pending', 'uploading', 'uploaded', 'extracting',
    'processing', 'ready', 'failed', 'needs_ocr'
  ));

ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS storage_provider TEXT,
  ADD COLUMN IF NOT EXISTS drive_file_id TEXT,
  ADD COLUMN IF NOT EXISTS drive_web_url TEXT,
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS extraction_error TEXT,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_drive_file
  ON public.knowledge_documents (drive_file_id)
  WHERE drive_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_filename_lower
  ON public.knowledge_documents (lower(filename));

-- ---------------------------------------------------------------------------
-- Full-text search on chunks (language-neutral simple config)
-- ---------------------------------------------------------------------------
ALTER TABLE public.knowledge_chunks
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_search
  ON public.knowledge_chunks USING GIN (search_vector);

-- ---------------------------------------------------------------------------
-- RPC: search knowledge chunks with FTS + filename matching
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_knowledge_chunks(
  p_base_ids UUID[],
  p_query TEXT,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  chunk_index INT,
  content TEXT,
  filename TEXT,
  knowledge_base_id UUID,
  fts_rank REAL,
  filename_score REAL
)
LANGUAGE sql
STABLE
AS $$
  WITH terms AS (
    SELECT unnest(
      regexp_split_to_array(
        lower(trim(coalesce(p_query, ''))),
        '[^[:alnum:][:alpha:]]+'
      )
    ) AS term
  ),
  filtered_terms AS (
    SELECT term FROM terms WHERE length(term) > 1
  ),
  query_ts AS (
    SELECT plainto_tsquery('simple', coalesce(p_query, '')) AS q
  )
  SELECT
    kc.id AS chunk_id,
    kd.id AS document_id,
    kc.chunk_index,
    kc.content,
    kd.filename,
    kd.knowledge_base_id,
    ts_rank(kc.search_vector, qt.q)::real AS fts_rank,
    (
      CASE WHEN lower(kd.filename) = lower(trim(p_query)) THEN 1.0
           WHEN lower(kd.filename) LIKE '%' || lower(trim(p_query)) || '%' THEN 0.8
           ELSE 0.0
      END
      +
      COALESCE((
        SELECT COUNT(*)::real / GREATEST((SELECT COUNT(*) FROM filtered_terms), 1)
        FROM filtered_terms ft
        WHERE lower(kd.filename) LIKE '%' || ft.term || '%'
           OR lower(kc.content) LIKE '%' || ft.term || '%'
      ), 0) * 0.3
    )::real AS filename_score
  FROM public.knowledge_chunks kc
  JOIN public.knowledge_documents kd ON kd.id = kc.document_id
  CROSS JOIN query_ts qt
  WHERE kd.knowledge_base_id = ANY(p_base_ids)
    AND kd.status = 'ready'
    AND (
      kc.search_vector @@ qt.q
      OR lower(kd.filename) LIKE '%' || lower(trim(p_query)) || '%'
      OR EXISTS (
        SELECT 1 FROM filtered_terms ft
        WHERE lower(kc.content) LIKE '%' || ft.term || '%'
           OR lower(kd.filename) LIKE '%' || ft.term || '%'
      )
    )
  ORDER BY (filename_score + fts_rank) DESC
  LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.search_knowledge_chunks(UUID[], TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_knowledge_chunks(UUID[], TEXT, INT) TO service_role;
