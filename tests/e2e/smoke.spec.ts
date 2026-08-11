import { test, expect } from "@playwright/test";

test.describe("Smoke e2e", () => {
  test("health endpoint returns ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.status).toBe("ok");
  });

  test("login page renders", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  });

  test("redirects unauthenticated user to login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/login/);
  });
});
