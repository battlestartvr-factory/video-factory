import { getSessionUser } from "@/lib/auth/session";
import { apiSuccess, apiError, readJsonBody } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import {
  getOrCreateAgentConfig,
  resetAgentConfig,
  updateAgentConfig,
} from "@/lib/agent/agent-config-service";
import { AGENT_RUNTIME_POLICY, AGENT_RUNTIME_POLICY_VERSION } from "@/lib/agent/runtime-policy";
import { z } from "zod";

const updateAgentConfigSchema = z.object({
  systemPrompt: z.string().min(1).max(20000),
});

export async function GET() {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const config = await getOrCreateAgentConfig(user.id);
  return apiSuccess({
    config,
    runtimePolicy: {
      version: AGENT_RUNTIME_POLICY_VERSION,
      text: AGENT_RUNTIME_POLICY,
    },
  });
}

export async function PATCH(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<unknown>(request);
  const parsed = updateAgentConfigSchema.safeParse(body);
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Некорректные данные", 400, requestId);

  try {
    const config = await updateAgentConfig(user.id, parsed.data.systemPrompt);
    return apiSuccess({ config });
  } catch {
    return apiError("UPDATE_FAILED", "Не удалось сохранить настройки агента", 500, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const body = await readJsonBody<{ action?: string }>(request);
  if (body.action !== "reset") {
    return apiError("VALIDATION_ERROR", "Неизвестное действие", 400, requestId);
  }

  try {
    const config = await resetAgentConfig(user.id);
    return apiSuccess({ config });
  } catch {
    return apiError("UPDATE_FAILED", "Не удалось восстановить базовый вариант", 500, requestId);
  }
}
