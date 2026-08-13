import { apiSuccess } from "@/lib/api/response";
import { getIntegrationsStatus } from "@/lib/integrations/status";

export async function GET() {
  const data = await getIntegrationsStatus();
  return apiSuccess(data);
}
