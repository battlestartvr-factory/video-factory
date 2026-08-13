import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";

export interface SupabaseErrorLogFields {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined ? undefined : value;
}

export function normalizeSupabaseApiKey(key: string): string {
  const trimmed = key.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function decodeJwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      role?: string;
    };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export function resolveSupabaseUrl(): string | null {
  const url = readEnv("NEXT_PUBLIC_SUPABASE_URL")?.trim();
  return url ? url : null;
}

export function resolveSupabaseServiceRoleKey(): string | null {
  const raw =
    readEnv("SUPABASE_SERVICE_ROLE_KEY") ??
    readEnv("SUPABASE_SECRET_KEY");
  if (!raw) return null;

  const key = normalizeSupabaseApiKey(raw);
  return key.length > 0 ? key : null;
}

export function assertServiceRoleKeyUsable(key: string): void {
  const role = decodeJwtRole(key);
  if (role === "anon") {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is configured with an anon JWT; use the service_role or sb_secret key",
    );
  }
}

export function formatSupabaseErrorForLog(
  error: PostgrestError | null | undefined,
): SupabaseErrorLogFields {
  if (!error) return {};
  const fields: SupabaseErrorLogFields = {};
  if (error.code) fields.code = error.code;
  if (error.message) fields.message = error.message;
  if (error.details) fields.details = error.details;
  if (error.hint) fields.hint = error.hint;
  return fields;
}
