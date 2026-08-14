import { apiSuccess } from "@/lib/api/response";
import { MODEL_REGISTRY } from "@/lib/models/registry";

export async function GET() {
  return apiSuccess({ models: MODEL_REGISTRY });
}
