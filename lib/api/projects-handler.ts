import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api/response";
import { createProjectSchema } from "@/lib/validation/schemas";
import { generateRequestId, createLogger } from "@/lib/logging/logger";

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const logger = createLogger({ requestId, event: "projects.create" });

  try {
    const user = await getSessionUser();
    if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

    const body = await request.json();
    const parsed = createProjectSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);
    }

    const supabase = await createSupabaseServerClient();
    const { data: project, error } = await supabase
      .from("projects")
      .insert({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        default_language: parsed.data.defaultLanguage,
        target_platforms: parsed.data.targetPlatforms,
        created_by: user.id,
      })
      .select()
      .single();

    if (error || !project) {
      logger.error("Project create failed", { code: error?.code });
      return apiError("CREATE_FAILED", "Не удалось создать проект", 500, requestId);
    }

    await supabase.from("project_members").insert({
      project_id: project.id,
      user_id: user.id,
      member_role: "owner",
    });

    logger.info("Project created", { projectId: project.id, userId: user.id });
    return apiSuccess(project, 201);
  } catch {
    return apiError("INTERNAL_ERROR", "Внутренняя ошибка", 500, requestId);
  }
}

export async function logoutHandler() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", process.env.APP_URL ?? "http://localhost:3000"));
}
