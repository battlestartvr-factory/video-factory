import { apiSuccess } from "@/lib/api/response";
import { isSupabaseConfigured } from "@/lib/env/env.client";
import { isGoogleDriveConfigured, isN8nConfigured, serverEnv } from "@/lib/env/env.server";

export async function GET() {
  return apiSuccess({
    supabase: isSupabaseConfigured(),
    n8n: isN8nConfigured(),
    googleDrive: isGoogleDriveConfigured(),
    mockWorkflows: serverEnv.MOCK_WORKFLOWS,
  });
}
