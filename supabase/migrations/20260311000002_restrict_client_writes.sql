-- Restrict client writes on production tables.
-- All INSERT/UPDATE/DELETE on projects, jobs, etc. must go through
-- Next.js API routes using the service role key after auth checks.

-- Harden SECURITY DEFINER helpers
CREATE OR REPLACE FUNCTION public.is_admin(uid UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = uid AND role = 'admin');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_project_access(uid UUID, pid UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin(uid) OR EXISTS (
    SELECT 1 FROM public.project_members WHERE project_id = pid AND user_id = uid
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_edit_project(uid UUID, pid UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin(uid) OR EXISTS (
    SELECT 1 FROM public.project_members
    WHERE project_id = pid AND user_id = uid AND member_role IN ('owner', 'editor')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, role)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)), 'member')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION public.protect_profile_sensitive_fields()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT public.is_admin(auth.uid()) THEN
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

-- Remove client write policies on production tables
DROP POLICY IF EXISTS projects_insert ON public.projects;
DROP POLICY IF EXISTS projects_update ON public.projects;
DROP POLICY IF EXISTS project_members_insert ON public.project_members;
DROP POLICY IF EXISTS project_members_update ON public.project_members;
DROP POLICY IF EXISTS project_members_delete ON public.project_members;
DROP POLICY IF EXISTS jobs_insert ON public.jobs;
DROP POLICY IF EXISTS jobs_update_client ON public.jobs;
DROP POLICY IF EXISTS job_events_insert ON public.job_events;
DROP POLICY IF EXISTS reviews_insert ON public.reviews;

-- Ensure SELECT policies use qualified helpers
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles FOR SELECT USING (
  auth.uid() = id OR public.is_admin(auth.uid())
);

DROP POLICY IF EXISTS projects_select ON public.projects;
CREATE POLICY projects_select ON public.projects FOR SELECT USING (
  public.has_project_access(auth.uid(), id)
);

DROP POLICY IF EXISTS project_members_select ON public.project_members;
CREATE POLICY project_members_select ON public.project_members FOR SELECT USING (
  public.has_project_access(auth.uid(), project_id)
);

DROP POLICY IF EXISTS jobs_select ON public.jobs;
CREATE POLICY jobs_select ON public.jobs FOR SELECT USING (
  public.has_project_access(auth.uid(), project_id)
);

DROP POLICY IF EXISTS job_events_select ON public.job_events;
CREATE POLICY job_events_select ON public.job_events FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = job_id AND public.has_project_access(auth.uid(), j.project_id)
  )
);

DROP POLICY IF EXISTS assets_select ON public.assets;
CREATE POLICY assets_select ON public.assets FOR SELECT USING (
  public.has_project_access(auth.uid(), project_id)
);

DROP POLICY IF EXISTS reviews_select ON public.reviews;
CREATE POLICY reviews_select ON public.reviews FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = job_id AND public.has_project_access(auth.uid(), j.project_id)
  )
);

DROP POLICY IF EXISTS usage_select ON public.usage_records;
CREATE POLICY usage_select ON public.usage_records FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = job_id AND public.has_project_access(auth.uid(), j.project_id)
  )
);
