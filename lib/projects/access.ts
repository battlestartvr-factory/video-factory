import { createSupabaseServiceClient } from "@/lib/supabase/server";

export async function userHasProjectAccess(userId: string, projectId: string): Promise<boolean> {
  const service = createSupabaseServiceClient();
  const { data: profile } = await service
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.role === "admin") return true;

  const { data } = await service
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();

  return Boolean(data);
}

export async function assertProjectAccess(userId: string, projectId: string): Promise<void> {
  const allowed = await userHasProjectAccess(userId, projectId);
  if (!allowed) {
    const error = new Error("FORBIDDEN");
    error.name = "ForbiddenError";
    throw error;
  }
}
