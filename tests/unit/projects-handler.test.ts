import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionUser, createSupabaseServiceClient } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  createSupabaseServiceClient: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionUser,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseServiceClient,
}));

import { POST } from "@/lib/api/projects-handler";

const userId = "739fb3c2-0a98-40dd-bb3a-22b9393630e6";

function buildRequest(body: unknown) {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects", () => {
  beforeEach(() => {
    getSessionUser.mockResolvedValue({ id: userId });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 201 and creates owner membership", async () => {
    const project = {
      id: "37760eaf-2ae6-45c7-879e-156fbb416566",
      name: "Test project",
      created_by: userId,
    };

    const projectInsert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({ data: project, error: null })),
      })),
    }));

    const membershipInsert = vi.fn(async () => ({ error: null }));

    createSupabaseServiceClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "projects") {
          return { insert: projectInsert };
        }
        if (table === "project_members") {
          return { insert: membershipInsert };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    });

    const res = await POST(
      buildRequest({
        name: "Test project",
        description: null,
        defaultLanguage: "ru",
        targetPlatforms: [],
      }),
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true, data: project });
    expect(projectInsert).toHaveBeenCalledWith({
      name: "Test project",
      description: null,
      default_language: "ru",
      target_platforms: [],
      created_by: userId,
    });
    expect(membershipInsert).toHaveBeenCalledWith({
      project_id: project.id,
      user_id: userId,
      member_role: "owner",
    });
  });

  it("returns 500 when Supabase project insert fails", async () => {
    const projectInsert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({
          data: null,
          error: {
            code: "42501",
            message: "new row violates row-level security policy for table \"projects\"",
            details: null,
            hint: null,
          },
        })),
      })),
    }));

    createSupabaseServiceClient.mockReturnValue({
      from: vi.fn(() => ({ insert: projectInsert })),
    });

    const res = await POST(
      buildRequest({
        name: "Blocked project",
        defaultLanguage: "ru",
        targetPlatforms: [],
      }),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CREATE_FAILED",
        message: "Не удалось создать проект",
      },
    });
  });

  it("returns 401 when user is not authenticated", async () => {
    getSessionUser.mockResolvedValue(null);

    const res = await POST(
      buildRequest({
        name: "Unauthorized project",
        defaultLanguage: "ru",
        targetPlatforms: [],
      }),
    );

    expect(res.status).toBe(401);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
