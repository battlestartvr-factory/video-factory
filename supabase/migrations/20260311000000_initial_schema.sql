-- AI Content Factory — initial schema
-- Run via Supabase CLI or Dashboard SQL editor

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE member_role AS ENUM ('owner', 'editor', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_type AS ENUM ('script', 'post', 'image', 'short_video', 'dev_diary');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM ('draft', 'queued', 'processing', 'review', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_mode AS ENUM ('economy', 'balanced', 'quality');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE asset_kind AS ENUM ('source', 'text', 'image', 'audio', 'video', 'thumbnail', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE review_decision AS ENUM ('approved', 'revision_requested');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Profiles
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  role user_role NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  status project_status NOT NULL DEFAULT 'active',
  default_language TEXT NOT NULL DEFAULT 'ru',
  target_platforms TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_created_by ON projects(created_by);

-- Project members
CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  member_role member_role NOT NULL DEFAULT 'editor',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- Jobs
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id),
  type job_type NOT NULL,
  status job_status NOT NULL DEFAULT 'draft',
  mode job_mode NOT NULL DEFAULT 'balanced',
  language TEXT NOT NULL DEFAULT 'ru',
  target_platform TEXT NOT NULL,
  brief TEXT,
  source_provider TEXT NOT NULL DEFAULT 'google_drive',
  source_external_id TEXT,
  source_url TEXT,
  progress SMALLINT NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  current_stage TEXT,
  n8n_execution_id TEXT,
  error_code TEXT,
  error_message TEXT,
  estimated_cost_usd NUMERIC(12,4),
  actual_cost_usd NUMERIC(12,4),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_project_created ON jobs(project_id, created_at DESC);

-- Job events
CREATE TABLE IF NOT EXISTS job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  status job_status,
  message TEXT,
  progress SMALLINT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_created ON job_events(job_id, created_at DESC);

-- Processed webhook events (idempotency)
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id UUID PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Assets
CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind asset_kind NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_assets_project_kind ON assets(project_id, kind);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id),
  decision review_decision NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Usage records
CREATE TABLE IF NOT EXISTS usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT,
  operation TEXT NOT NULL,
  input_units NUMERIC(12,4),
  output_units NUMERIC(12,4),
  cost_usd NUMERIC(12,6) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS project_members_updated_at ON project_members;
CREATE TRIGGER project_members_updated_at BEFORE UPDATE ON project_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS jobs_updated_at ON jobs;
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)), 'member')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;

-- Helper: is admin
CREATE OR REPLACE FUNCTION is_admin(uid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = uid AND role = 'admin');
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Helper: project access
CREATE OR REPLACE FUNCTION has_project_access(uid UUID, pid UUID)
RETURNS BOOLEAN AS $$
  SELECT is_admin(uid) OR EXISTS (
    SELECT 1 FROM project_members WHERE project_id = pid AND user_id = uid
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION can_edit_project(uid UUID, pid UUID)
RETURNS BOOLEAN AS $$
  SELECT is_admin(uid) OR EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = pid AND user_id = uid AND member_role IN ('owner', 'editor')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Prevent non-admin users from escalating role or changing protected fields
CREATE OR REPLACE FUNCTION protect_profile_sensitive_fields()
RETURNS TRIGGER AS $$
BEGIN
  -- Service role / backend bypass (auth.uid() is NULL)
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT is_admin(auth.uid()) THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'permission denied: cannot change role';
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN
      RAISE EXCEPTION 'permission denied: cannot change email';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'permission denied: cannot change id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS protect_profile_sensitive_fields ON profiles;
CREATE TRIGGER protect_profile_sensitive_fields
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION protect_profile_sensitive_fields();

-- Profiles policies
DROP POLICY IF EXISTS profiles_select ON profiles;
CREATE POLICY profiles_select ON profiles FOR SELECT USING (
  auth.uid() = id OR is_admin(auth.uid())
);

-- Members may update own display_name only; role/email guarded by trigger above
DROP POLICY IF EXISTS profiles_update_self ON profiles;
CREATE POLICY profiles_update_self ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Admins may update any profile including role
DROP POLICY IF EXISTS profiles_update_admin ON profiles;
CREATE POLICY profiles_update_admin ON profiles FOR UPDATE
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- Projects policies
DROP POLICY IF EXISTS projects_select ON projects;
CREATE POLICY projects_select ON projects FOR SELECT USING (
  has_project_access(auth.uid(), id)
);

DROP POLICY IF EXISTS projects_insert ON projects;
CREATE POLICY projects_insert ON projects FOR INSERT WITH CHECK (
  auth.uid() = created_by
);

DROP POLICY IF EXISTS projects_update ON projects;
CREATE POLICY projects_update ON projects FOR UPDATE USING (
  can_edit_project(auth.uid(), id)
);

-- Project members policies
DROP POLICY IF EXISTS project_members_select ON project_members;
CREATE POLICY project_members_select ON project_members FOR SELECT USING (
  has_project_access(auth.uid(), project_id)
);

DROP POLICY IF EXISTS project_members_insert ON project_members;
CREATE POLICY project_members_insert ON project_members FOR INSERT WITH CHECK (
  can_edit_project(auth.uid(), project_id) OR is_admin(auth.uid())
);

DROP POLICY IF EXISTS project_members_update ON project_members;
CREATE POLICY project_members_update ON project_members FOR UPDATE USING (
  can_edit_project(auth.uid(), project_id) OR is_admin(auth.uid())
);

DROP POLICY IF EXISTS project_members_delete ON project_members;
CREATE POLICY project_members_delete ON project_members FOR DELETE USING (
  can_edit_project(auth.uid(), project_id) OR is_admin(auth.uid())
);

-- Jobs policies
DROP POLICY IF EXISTS jobs_select ON jobs;
CREATE POLICY jobs_select ON jobs FOR SELECT USING (
  has_project_access(auth.uid(), project_id)
);

DROP POLICY IF EXISTS jobs_insert ON jobs;
CREATE POLICY jobs_insert ON jobs FOR INSERT WITH CHECK (
  can_edit_project(auth.uid(), project_id) AND auth.uid() = created_by
);

DROP POLICY IF EXISTS jobs_update_client ON jobs;
CREATE POLICY jobs_update_client ON jobs FOR UPDATE USING (
  can_edit_project(auth.uid(), project_id)
);

-- Job events
DROP POLICY IF EXISTS job_events_select ON job_events;
CREATE POLICY job_events_select ON job_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND has_project_access(auth.uid(), j.project_id))
);

DROP POLICY IF EXISTS job_events_insert ON job_events;
CREATE POLICY job_events_insert ON job_events FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND has_project_access(auth.uid(), j.project_id))
);

-- Assets
DROP POLICY IF EXISTS assets_select ON assets;
CREATE POLICY assets_select ON assets FOR SELECT USING (
  has_project_access(auth.uid(), project_id)
);

-- Reviews
DROP POLICY IF EXISTS reviews_select ON reviews;
CREATE POLICY reviews_select ON reviews FOR SELECT USING (
  EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND has_project_access(auth.uid(), j.project_id))
);

DROP POLICY IF EXISTS reviews_insert ON reviews;
CREATE POLICY reviews_insert ON reviews FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND can_edit_project(auth.uid(), j.project_id))
  AND auth.uid() = user_id
);

-- Usage records
DROP POLICY IF EXISTS usage_select ON usage_records;
CREATE POLICY usage_select ON usage_records FOR SELECT USING (
  EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id AND has_project_access(auth.uid(), j.project_id))
);

-- processed_webhook_events: service role only (no client policies)
