import { apiSuccess } from "@/lib/api/response";
import { getPublicModels } from "@/lib/models/kie/registry";
import type { ModelCategory } from "@/lib/models/kie/types";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const category = url.searchParams.get("category") as ModelCategory | null;

  const models = getPublicModels(category ?? undefined);
  return apiSuccess({ models });
}
