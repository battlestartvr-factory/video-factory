export interface OrchestratorRpcError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface OrchestratorRpcResponse {
  data: unknown;
  error: OrchestratorRpcError | null;
}

export interface OrchestratorRpcClient {
  rpc(
    functionName: string,
    args?: Record<string, unknown>,
  ): Promise<OrchestratorRpcResponse>;
}

export function requireRpcObject(data: unknown, operation: string): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Invalid ${operation} RPC response`);
  }
  return data as Record<string, unknown>;
}
