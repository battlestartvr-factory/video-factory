import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { canEditProject, getProfile, getSessionUser } from "@/lib/auth/session";
import type { UserRole } from "@/lib/types/database";

export async function requireFactoryUser() {
  const user = await getSessionUser();
  if (!user) return { error: "UNAUTHORIZED" as const, user: null, profile: null };
  const profile = await getProfile(user.id);
  return { error: null, user, profile };
}

export async function requireProjectEditor(projectId: string, userId: string, role?: UserRole) {
  const allowed = await canEditProject(userId, projectId, role);
  if (!allowed) return { error: "FORBIDDEN" as const };
  return { error: null };
}

export async function getFactoryJobForUser(jobId: string, userId: string, role?: UserRole) {
  const supabase = await createSupabaseServerClient();
  const { data: job, error } = await supabase
    .from("factory_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (error || !job) {
    return { error: "NOT_FOUND" as const, job: null };
  }

  const access = await requireProjectEditor(job.project_id, userId, role);
  if (access.error) {
    return { error: access.error, job: null };
  }

  return { error: null, job };
}

export async function validateSourceAssetsBelongToProject(
  assetIds: string[],
  projectId: string,
): Promise<boolean> {
  if (assetIds.length === 0) return true;

  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("assets")
    .select("id")
    .eq("project_id", projectId)
    .in("id", assetIds);

  if (error) return false;
  return (data?.length ?? 0) === assetIds.length;
}

export async function validateFactoryAssetBelongsToJob(
  assetId: string,
  jobId: string,
  stage?: string,
): Promise<boolean> {
  const service = createSupabaseServiceClient();
  const { data: asset, error } = await service
    .from("factory_assets")
    .select("id, stage_id")
    .eq("id", assetId)
    .eq("job_id", jobId)
    .maybeSingle();

  if (error || !asset) return false;
  if (!stage) return true;
  if (!asset.stage_id) return false;

  const { data: stageRow } = await service
    .from("factory_job_stages")
    .select("stage")
    .eq("id", asset.stage_id)
    .maybeSingle();

  return stageRow?.stage === stage;
}
