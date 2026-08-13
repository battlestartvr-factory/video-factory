import { afterEach, describe, expect, it } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import {
  formatSupabaseErrorForLog,
  normalizeSupabaseApiKey,
  resolveSupabaseServiceRoleKey,
  assertServiceRoleKeyUsable,
} from "@/lib/supabase/service-config";

describe("normalizeSupabaseApiKey", () => {
  it("trims whitespace", () => {
    expect(normalizeSupabaseApiKey("  sb_secret_abc  ")).toBe("sb_secret_abc");
  });

  it("strips surrounding double quotes", () => {
    expect(normalizeSupabaseApiKey('"eyJ.test.signature"')).toBe("eyJ.test.signature");
  });

  it("strips surrounding single quotes", () => {
    expect(normalizeSupabaseApiKey("'eyJ.test.signature'")).toBe("eyJ.test.signature");
  });
});

describe("resolveSupabaseServiceRoleKey", () => {
  afterEach(() => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
  });

  it("prefers SUPABASE_SERVICE_ROLE_KEY", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "  role-key  ";
    process.env.SUPABASE_SECRET_KEY = "secret-key";
    expect(resolveSupabaseServiceRoleKey()).toBe("role-key");
  });

  it("falls back to SUPABASE_SECRET_KEY", () => {
    process.env.SUPABASE_SECRET_KEY = '"sb_secret_example"';
    expect(resolveSupabaseServiceRoleKey()).toBe("sb_secret_example");
  });
});

describe("assertServiceRoleKeyUsable", () => {
  it("rejects anon JWT keys", () => {
    const anonPayload = Buffer.from(
      JSON.stringify({ role: "anon", iss: "supabase" }),
      "utf8",
    ).toString("base64url");
    const anonJwt = `header.${anonPayload}.signature`;
    expect(() => assertServiceRoleKeyUsable(anonJwt)).toThrow(/anon JWT/i);
  });

  it("allows service_role JWT keys", () => {
    const servicePayload = Buffer.from(
      JSON.stringify({ role: "service_role", iss: "supabase" }),
      "utf8",
    ).toString("base64url");
    const serviceJwt = `header.${servicePayload}.signature`;
    expect(() => assertServiceRoleKeyUsable(serviceJwt)).not.toThrow();
  });

  it("allows opaque sb_secret keys", () => {
    expect(() => assertServiceRoleKeyUsable("sb_secret_example")).not.toThrow();
  });
});

describe("formatSupabaseErrorForLog", () => {
  it("maps PostgREST error fields without secrets", () => {
    const error = {
      code: "42501",
      message: 'new row violates row-level security policy for table "projects"',
      details: "",
      hint: "",
      name: "PostgrestError",
    } as PostgrestError;

    expect(formatSupabaseErrorForLog(error)).toEqual({
      code: "42501",
      message: 'new row violates row-level security policy for table "projects"',
    });
  });
});
