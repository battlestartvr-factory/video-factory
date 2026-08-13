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
  GOOGLE_DRIVE_CLIENT_EMAIL: z.string().optional().or(z.literal("")),
  GOOGLE_DRIVE_PRIVATE_KEY: z.string().optional().or(z.literal("")),
  GOOGLE_DRIVE_SHARED_FOLDER_ID: z.string().optional().or(z.literal("")),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  INGEST_PROXY_TOKEN: z.string().optional().or(z.literal("")),
  B2_S3_ENDPOINT: z.string().optional().or(z.literal("")),
  B2_REGION: z.string().optional().or(z.literal("")),
  B2_ACCESS_KEY_ID: z.string().optional().or(z.literal("")),
  B2_SECRET_ACCESS_KEY: z.string().optional().or(z.literal("")),
  B2_BUCKET: z.string().optional().or(z.literal("")),
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
  return (
    serverEnv.GOOGLE_DRIVE_INTEGRATION_ENABLED &&
    Boolean(
      serverEnv.GOOGLE_DRIVE_CLIENT_EMAIL &&
        serverEnv.GOOGLE_DRIVE_PRIVATE_KEY,
    )
  );
}
