import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { MemberRole, UserRole } from "@/lib/types/database";

export async function getSessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user;
}

export async function getProfile(userId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
  return data;
}

export async function canEditProject(userId: string, projectId: string, role?: UserRole) {
  if (role === "admin") return true;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("project_members")
    .select("member_role")
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .single();
  const memberRole = data?.member_role as MemberRole | undefined;
  return memberRole === "owner" || memberRole === "editor";
}
