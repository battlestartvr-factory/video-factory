import "server-only";
import { z } from "zod";

const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional().or(z.literal("")),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional().or(z.literal("")),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal("")),
  SUPABASE_SECRET_KEY: z.string().optional().or(z.literal("")),
  N8N_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  N8N_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
  N8N_FACTORY_BASE_URL: z.string().url().optional().or(z.literal("")),
  FACTORY_WEBHOOK_SECRET: z.string().optional().or(z.literal("")),
  APP_URL: z.string().url().default("http://localhost:3000"),
  GOOGLE_DRIVE_INTEGRATION_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  GOOGLE_DRIVE_AUTH_MODE: z.enum(["service_account", "oauth_user"]).optional(),
  GOOGLE_DRIVE_CLIENT_EMAIL: z.string().optional().or(z.literal("")),
  GOOGLE_DRIVE_PRIVATE_KEY: z.string().optional().or(z.literal("")),
  GOOGLE_DRIVE_CLIENT_ID: z.string().optional().or(z.literal("")),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  GOOGLE_DRIVE_REFRESH_TOKEN: z.string().optional().or(z.literal("")),
  GOOGLE_DRIVE_SHARED_FOLDER_ID: z.string().optional().or(z.literal("")),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  INGEST_PROXY_TOKEN: z.string().optional().or(z.literal("")),
  B2_S3_ENDPOINT: z.string().optional().or(z.literal("")),
  B2_REGION: z.string().optional().or(z.literal("")),
  B2_ACCESS_KEY_ID: z.string().optional().or(z.literal("")),
  B2_SECRET_ACCESS_KEY: z.string().optional().or(z.literal("")),
  B2_BUCKET: z.string().optional().or(z.literal("")),
  KIE_API_KEY: z.string().optional().or(z.literal("")),
  KIE_API_BASE_URL: z.string().optional().or(z.literal("")),
  AGENT_LLM_BASE_URL: z.string().url().optional().or(z.literal("")),
  AGENT_LLM_API_KEY: z.string().optional().or(z.literal("")),
  AGENT_LLM_DEFAULT_MODEL: z.string().optional().or(z.literal("")),
  AGENT_LLM_ALLOWED_MODELS: z.string().optional().or(z.literal("")),
  WEB_SEARCH_PROVIDER: z.string().optional().or(z.literal("")),
  WEB_SEARCH_API_KEY: z.string().optional().or(z.literal("")),
  WEB_SEARCH_BASE_URL: z.string().optional().or(z.literal("")),
});

function parseServerEnv() {
  return serverEnvSchema.parse(process.env);
}

export const serverEnv = parseServerEnv();

export function isN8nConfigured(): boolean {
  return Boolean(serverEnv.N8N_WEBHOOK_URL && serverEnv.N8N_WEBHOOK_SECRET);
}

export function isFactoryN8nConfigured(): boolean {
  return Boolean(serverEnv.N8N_FACTORY_BASE_URL && serverEnv.FACTORY_WEBHOOK_SECRET);
}

export function isGoogleDriveConfigured(): boolean {
  if (!serverEnv.GOOGLE_DRIVE_INTEGRATION_ENABLED) return false;

  const oauthConfigured = Boolean(
    serverEnv.GOOGLE_DRIVE_CLIENT_ID &&
      serverEnv.GOOGLE_DRIVE_CLIENT_SECRET &&
      serverEnv.GOOGLE_DRIVE_REFRESH_TOKEN &&
      serverEnv.GOOGLE_DRIVE_SHARED_FOLDER_ID,
  );
  if (oauthConfigured) return true;

  const authMode = (serverEnv.GOOGLE_DRIVE_AUTH_MODE ?? "service_account").trim();
  if (authMode === "oauth_user") return false;

  return Boolean(
    serverEnv.GOOGLE_DRIVE_CLIENT_EMAIL &&
      serverEnv.GOOGLE_DRIVE_PRIVATE_KEY &&
      serverEnv.GOOGLE_DRIVE_SHARED_FOLDER_ID,
  );
}

const KIE_DEFAULT_BASE_URL = "https://api.kie.ai";

/** Normalize a base URL to the KIE provider root (never a model-specific endpoint). */
export function normalizeKieBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "api.kie.ai" || parsed.hostname.endsWith(".kie.ai")) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export function getKieConfig() {
  const apiKey = (serverEnv.KIE_API_KEY ?? serverEnv.AGENT_LLM_API_KEY ?? "").trim();
  const canonicalBaseUrl = (serverEnv.KIE_API_BASE_URL ?? "").trim();
  const legacyBaseUrl = normalizeKieBaseUrl(serverEnv.AGENT_LLM_BASE_URL ?? "");
  const baseUrl =
    (canonicalBaseUrl || legacyBaseUrl || KIE_DEFAULT_BASE_URL).replace(/\/+$/, "") ||
    KIE_DEFAULT_BASE_URL;

  return {
    configured: Boolean(apiKey),
    baseUrl,
    apiKey,
  };
}

export function isKieConfigured(): boolean {
  return getKieConfig().configured;
}

/** @deprecated Use getKieConfig() — kept for backward compatibility */
export function getAgentLlmConfig() {
  const kie = getKieConfig();
  const defaultModel =
    (serverEnv.AGENT_LLM_DEFAULT_MODEL ?? "").trim() || "gemini-3-6-flash";
  const allowedModels = (serverEnv.AGENT_LLM_ALLOWED_MODELS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    configured: kie.configured,
    baseUrl: kie.baseUrl,
    apiKey: kie.apiKey,
    defaultModel,
    allowedModels,
  };
}

export function isAgentProviderConfigured(): boolean {
  return isKieConfigured();
}

export function getWebSearchConfig() {
  const provider = (serverEnv.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  const apiKey = (serverEnv.WEB_SEARCH_API_KEY ?? "").trim();
  const baseUrl = (serverEnv.WEB_SEARCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const configured =
    Boolean(provider) &&
    provider !== "none" &&
    Boolean(apiKey) &&
    (provider !== "generic" || Boolean(baseUrl));

  return { configured, provider, apiKey, baseUrl };
}

export function isWebSearchConfigured(): boolean {
  return getWebSearchConfig().configured;
}
