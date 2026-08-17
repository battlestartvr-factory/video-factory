import { getSessionUser } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { PRODUCT_MISSION, PRODUCT_MISSION_VERSION } from "@/lib/agent/product-mission";
import {
  AGENT_OPERATING_INSTRUCTIONS_VERSION,
  DEFAULT_GLOBAL_AGENT_INSTRUCTIONS,
} from "@/lib/agent/default-agent-instructions";
import { AGENT_RUNTIME_POLICY, AGENT_RUNTIME_POLICY_VERSION } from "@/lib/agent/runtime-policy";

export async function GET() {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  return apiSuccess({
    productMission: {
      version: PRODUCT_MISSION_VERSION,
      text: PRODUCT_MISSION,
    },
    operatingInstructions: {
      version: AGENT_OPERATING_INSTRUCTIONS_VERSION,
      text: DEFAULT_GLOBAL_AGENT_INSTRUCTIONS,
    },
    runtimePolicy: {
      version: AGENT_RUNTIME_POLICY_VERSION,
      text: AGENT_RUNTIME_POLICY,
    },
  });
}

export async function PATCH() {
  const requestId = generateRequestId();
  return apiError(
    "READ_ONLY",
    "Миссия и системные инструкции агента управляются кодом и не редактируются из UI",
    405,
    requestId,
  );
}

export async function POST() {
  const requestId = generateRequestId();
  return apiError(
    "READ_ONLY",
    "Миссия и системные инструкции агента управляются кодом и не редактируются из UI",
    405,
    requestId,
  );
}
