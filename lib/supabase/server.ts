import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { clientEnv } from "@/lib/env/env.client";
import {
  assertServiceRoleKeyUsable,
  resolveSupabaseServiceRoleKey,
  resolveSupabaseUrl,
} from "@/lib/supabase/service-config";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase is not configured");
  }

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Server Component — ignore
        }
      },
    },
  });
}

export function createSupabaseServiceClient() {
  const url = resolveSupabaseUrl();
  const key = resolveSupabaseServiceRoleKey();

  if (!url || !key) {
    throw new Error("Supabase service role is not configured");
  }

  assertServiceRoleKeyUsable(key);

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createSupabaseBrowserClient() {
  const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase is not configured");
  }

  return createClient(url, key);
}
