import { getSessionUser } from "@/lib/auth/session";
import { apiError, apiSuccess } from "@/lib/api/response";
import { generateRequestId } from "@/lib/logging/logger";
import { getKieConfig, isGoogleDriveConfigured } from "@/lib/env/env.server";

export async function GET() {
  const requestId = generateRequestId();
  const user = await getSessionUser();
  if (!user) return apiError("UNAUTHORIZED", "Требуется авторизация", 401, requestId);

  const kie = getKieConfig();
  const webSearchProvider = (process.env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  const mockWorkflows = (process.env.MOCK_WORKFLOWS ?? "false").trim().toLowerCase() === "true";
  const readiness = {
    kieConfigured: kie.configured,
    webSearchProvider,
    kieOnlySearchEnabled: webSearchProvider === "kie",
    googleDriveConfigured: isGoogleDriveConfigured(),
    mockWorkflows,
    models: {
      webSearch: (process.env.KIE_WEB_SEARCH_MODEL ?? "").trim() || "gemini-3-6-flash",
      researchSynthesis: (process.env.KIE_RESEARCH_SYNTHESIS_MODEL ?? "").trim() || "gemini-3-6-flash",
      conceptDesigner: (process.env.KIE_CONCEPT_DESIGNER_MODEL ?? "").trim() || "gemini-3-6-flash",
      conceptCurator: (process.env.KIE_CONCEPT_CURATOR_MODEL ?? "").trim() || "gemini-3-6-flash",
    },
  };

  return apiSuccess({
    ...readiness,
    readyForManualV2Test:
      readiness.kieConfigured &&
      readiness.kieOnlySearchEnabled &&
      readiness.googleDriveConfigured &&
      !readiness.mockWorkflows,
    paidProbePerformed: false,
    note: "Readiness inspects local configuration only and never calls KIE or another paid provider.",
  });
}
