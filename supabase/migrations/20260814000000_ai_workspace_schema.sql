-- AI Workspace — additive schema for chat, memory, knowledge, presets, generations
-- Does NOT modify n8n workflows or drop existing data.

-- pgvector for future RAG embeddings (optional, safe if unavailable)
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- projects: system prompt / instructions
-- ---------------------------------------------------------------------------
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS system_prompt TEXT;

-- ---------------------------------------------------------------------------
-- chats
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Новый чат',
  summary TEXT,
  model_id TEXT,
  preset_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chats_user_updated ON public.chats (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_project_updated ON public.chats (project_id, updated_at DESC)
  WHERE project_id IS NOT NULL;

DROP TRIGGER IF EXISTS chats_updated_at ON public.chats;
CREATE TRIGGER chats_updated_at
  BEFORE UPDATE ON public.chats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_created
  ON public.chat_messages (chat_id, created_at ASC);

-- ---------------------------------------------------------------------------
-- chat_attachments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  message_id UUID REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT,
  storage_path TEXT,
  url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON public.chat_attachments (message_id);

-- ---------------------------------------------------------------------------
-- chat_job_links — bridge chat messages to legacy/factory jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_job_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  message_id UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  job_id UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  factory_job_id UUID REFERENCES public.factory_jobs(id) ON DELETE SET NULL,
  action JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_job_links_has_job CHECK (job_id IS NOT NULL OR factory_job_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_chat_job_links_chat ON public.chat_job_links (chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_job_links_message ON public.chat_job_links (message_id);

-- ---------------------------------------------------------------------------
-- presets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('chat', 'image', 'video')),
  name TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_default BOOLEAN NOT NULL DEFAULT false,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_presets_user_type ON public.presets (user_id, type);

DROP TRIGGER IF EXISTS presets_updated_at ON public.presets;
CREATE TRIGGER presets_updated_at
  BEFORE UPDATE ON public.presets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed system default presets (idempotent)
INSERT INTO public.presets (id, user_id, type, name, is_system, is_default, settings)
VALUES
  ('00000000-0000-4000-8000-000000000001', NULL, 'chat', 'По умолчанию', true, true, '{}'),
  ('00000000-0000-4000-8000-000000000002', NULL, 'image', 'По умолчанию', true, true, '{}'),
  ('00000000-0000-4000-8000-000000000003', NULL, 'video', 'По умолчанию', true, true, '{}')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- memory_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  category TEXT,
  source TEXT,
  importance SMALLINT NOT NULL DEFAULT 5 CHECK (importance >= 1 AND importance <= 10),
  pinned BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memory_items_project_scope CHECK (
    (scope = 'global' AND project_id IS NULL) OR
    (scope = 'project' AND project_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_memory_items_user_scope ON public.memory_items (user_id, scope);
CREATE INDEX IF NOT EXISTS idx_memory_items_project ON public.memory_items (project_id)
  WHERE project_id IS NOT NULL;

DROP TRIGGER IF EXISTS memory_items_updated_at ON public.memory_items;
CREATE TRIGGER memory_items_updated_at
  BEFORE UPDATE ON public.memory_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- user_preferences
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_preferences (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  personalization JSONB NOT NULL DEFAULT '{}',
  appearance JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS user_preferences_updated_at ON public.user_preferences;
CREATE TRIGGER user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- knowledge_bases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT 'Основная база',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user ON public.knowledge_bases (user_id);

DROP TRIGGER IF EXISTS knowledge_bases_updated_at ON public.knowledge_bases;
CREATE TRIGGER knowledge_bases_updated_at
  BEFORE UPDATE ON public.knowledge_bases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- knowledge_documents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  storage_path TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  extracted_text TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_base ON public.knowledge_documents (knowledge_base_id);

DROP TRIGGER IF EXISTS knowledge_documents_updated_at ON public.knowledge_documents;
CREATE TRIGGER knowledge_documents_updated_at
  BEFORE UPDATE ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- knowledge_chunks (RAG-ready)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_chunks_document_index_key UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON public.knowledge_chunks (document_id);

-- ---------------------------------------------------------------------------
-- generations (image/video)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image', 'video')),
  mode TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model_id TEXT NOT NULL,
  preset_id UUID REFERENCES public.presets(id) ON DELETE SET NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  reference_assets JSONB NOT NULL DEFAULT '[]',
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  chat_id UUID REFERENCES public.chats(id) ON DELETE SET NULL,
  message_id UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  outputs JSONB NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_generations_user_created ON public.generations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_type_status ON public.generations (type, status);

DROP TRIGGER IF EXISTS generations_updated_at ON public.generations;
CREATE TRIGGER generations_updated_at
  BEFORE UPDATE ON public.generations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_job_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generations ENABLE ROW LEVEL SECURITY;

-- chats: owner or project member
DROP POLICY IF EXISTS chats_select ON public.chats;
CREATE POLICY chats_select ON public.chats FOR SELECT USING (
  user_id = auth.uid()
  OR (project_id IS NOT NULL AND public.has_project_access(auth.uid(), project_id))
);

-- chat_messages: via chat access
DROP POLICY IF EXISTS chat_messages_select ON public.chat_messages;
CREATE POLICY chat_messages_select ON public.chat_messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.chats c
    WHERE c.id = chat_id
      AND (c.user_id = auth.uid()
        OR (c.project_id IS NOT NULL AND public.has_project_access(auth.uid(), c.project_id)))
  )
);

-- chat_attachments
DROP POLICY IF EXISTS chat_attachments_select ON public.chat_attachments;
CREATE POLICY chat_attachments_select ON public.chat_attachments FOR SELECT USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.chats c
    WHERE c.id = chat_id AND c.project_id IS NOT NULL
      AND public.has_project_access(auth.uid(), c.project_id)
  )
);

-- chat_job_links
DROP POLICY IF EXISTS chat_job_links_select ON public.chat_job_links;
CREATE POLICY chat_job_links_select ON public.chat_job_links FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.chats c
    WHERE c.id = chat_id
      AND (c.user_id = auth.uid()
        OR (c.project_id IS NOT NULL AND public.has_project_access(auth.uid(), c.project_id)))
  )
);

-- presets: system presets visible to all; user presets to owner
DROP POLICY IF EXISTS presets_select ON public.presets;
CREATE POLICY presets_select ON public.presets FOR SELECT USING (
  is_system = true OR user_id = auth.uid()
);

-- memory_items
DROP POLICY IF EXISTS memory_items_select ON public.memory_items;
CREATE POLICY memory_items_select ON public.memory_items FOR SELECT USING (
  user_id = auth.uid()
  OR (scope = 'project' AND project_id IS NOT NULL
      AND public.has_project_access(auth.uid(), project_id))
);

-- user_preferences
DROP POLICY IF EXISTS user_preferences_select ON public.user_preferences;
CREATE POLICY user_preferences_select ON public.user_preferences FOR SELECT USING (
  user_id = auth.uid()
);

-- knowledge_bases
DROP POLICY IF EXISTS knowledge_bases_select ON public.knowledge_bases;
CREATE POLICY knowledge_bases_select ON public.knowledge_bases FOR SELECT USING (
  user_id = auth.uid()
  OR (project_id IS NOT NULL AND public.has_project_access(auth.uid(), project_id))
);

-- knowledge_documents
DROP POLICY IF EXISTS knowledge_documents_select ON public.knowledge_documents;
CREATE POLICY knowledge_documents_select ON public.knowledge_documents FOR SELECT USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.knowledge_bases kb
    WHERE kb.id = knowledge_base_id
      AND kb.project_id IS NOT NULL
      AND public.has_project_access(auth.uid(), kb.project_id)
  )
);

-- knowledge_chunks via document
DROP POLICY IF EXISTS knowledge_chunks_select ON public.knowledge_chunks;
CREATE POLICY knowledge_chunks_select ON public.knowledge_chunks FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.knowledge_documents kd
    WHERE kd.id = document_id
      AND (kd.user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.knowledge_bases kb
          WHERE kb.id = kd.knowledge_base_id
            AND kb.project_id IS NOT NULL
            AND public.has_project_access(auth.uid(), kb.project_id)
        ))
  )
);

-- generations
DROP POLICY IF EXISTS generations_select ON public.generations;
CREATE POLICY generations_select ON public.generations FOR SELECT USING (
  user_id = auth.uid()
  OR (project_id IS NOT NULL AND public.has_project_access(auth.uid(), project_id))
);

-- Revoke client writes (API uses service role)
REVOKE INSERT, UPDATE, DELETE ON public.chats FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.chat_messages FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.chat_attachments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.chat_job_links FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.presets FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.memory_items FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.user_preferences FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.knowledge_bases FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.knowledge_documents FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.knowledge_chunks FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.generations FROM anon, authenticated;
