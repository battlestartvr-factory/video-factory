import { createClient } from "@supabase/supabase-js";
import type { OrchestratorRpcClient, OrchestratorRpcResponse } from "../lib/orchestrator/rpc";

export function createWorkerRpcClient(url: string, serviceRoleKey: string): OrchestratorRpcClient {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async rpc(functionName, args): Promise<OrchestratorRpcResponse> {
      const { data, error } = await client.rpc(functionName, args);
      return {
        data,
        error: error
          ? {
              message: error.message,
              code: error.code,
              details: error.details,
              hint: error.hint,
            }
          : null,
      };
    },
  };
}
