import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/login?next=%2Fchat");
  await page.getByRole("button", { name: /Google로 로그인/ }).click();
  await expect(page).toHaveURL(/\/chat$/, { timeout: 20_000 });
}

test("chat program tab lists only real programs while unassigned conversations stay in Direct", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "메시지" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: "프로그램", exact: true }).click();
  const sidebar = page.locator("aside");
  await expect(sidebar.getByText("XPHERO 크리에이터 챌린지").first()).toBeVisible({ timeout: 20_000 });
  await expect(sidebar.getByText(/캠페인 \d+개 · 참여 \d+명/).first()).toBeVisible();
  await expect(sidebar.getByText("프로그램 외")).toHaveCount(0);
  await page.getByRole("tab", { name: "Direct" }).click();
  await expect(page.getByText("@supercent_official").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("hesse@supercent.io").first()).toBeVisible();
});
