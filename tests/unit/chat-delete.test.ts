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

import { DELETE } from "@/app/api/chats/[chatId]/route";

const ownerId = "739fb3c2-0a98-40dd-bb3a-22b9393630e6";
const otherId = "839fb3c2-0a98-40dd-bb3a-22b9393630e7";
const chatId = "37760eaf-2ae6-45c7-879e-156fbb416566";

function deleteRequest() {
  return new Request(`http://localhost/api/chats/${chatId}`, { method: "DELETE" });
}

describe("DELETE /api/chats/[chatId]", () => {
  beforeEach(() => {
    getSessionUser.mockResolvedValue({ id: ownerId });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without session", async () => {
    getSessionUser.mockResolvedValue(null);
    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ chatId }) });
    expect(res.status).toBe(401);
  });

  it("cannot delete another user's chat", async () => {
    createSupabaseServiceClient.mockReturnValue({
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(async () => ({
              data: { id: chatId, user_id: otherId },
              error: null,
            })),
          })),
        })),
      })),
    });

    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ chatId }) });
    expect(res.status).toBe(404);
  });

  it("hard deletes owned chat", async () => {
    const deleteEq = vi.fn(async () => ({ error: null }));
    const deleteFn = vi.fn(() => ({ eq: deleteEq }));
    const selectSingle = vi.fn(async () => ({
      data: { id: chatId, user_id: ownerId, title: "Test" },
      error: null,
    }));

    createSupabaseServiceClient.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "chats") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({ single: selectSingle })),
            })),
            delete: deleteFn,
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    });

    const res = await DELETE(deleteRequest(), { params: Promise.resolve({ chatId }) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, data: { deleted: true } });
    expect(deleteFn).toHaveBeenCalled();
    expect(deleteEq).toHaveBeenCalledWith("id", chatId);
  });
});
