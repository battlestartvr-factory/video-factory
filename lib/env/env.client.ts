import { z } from "zod";

const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional().or(z.literal("")),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional().or(z.literal("")),
  NEXT_PUBLIC_MOCK_WORKFLOWS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

function parseClientEnv() {
  return clientEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_MOCK_WORKFLOWS: process.env.MOCK_WORKFLOWS,
  });
}

export const clientEnv = parseClientEnv();

export function isSupabaseConfigured(): boolean {
  return Boolean(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL && clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

export function isMockMode(): boolean {
  return clientEnv.NEXT_PUBLIC_MOCK_WORKFLOWS ?? true;
}
