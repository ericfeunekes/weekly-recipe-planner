import { expect, test } from "@playwright/test";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";

test("Week can show a focused number of days", async ({ page }) => {
  const reset = await page.request.post(`${controlOrigin}/reset`);
  expect(reset.ok()).toBe(true);
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  const planner = page.getByText("Family dinner planner");
  await expect(setup.or(planner)).toBeVisible();
  if (await setup.isVisible()) await page.getByRole("button", { name: "Start Fresh" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();

  const weekGrid = page.locator(".week-grid");
  await expect(weekGrid.locator(".day-column")).toHaveCount(7);
  await page.getByRole("radio", { name: "Show 3 days" }).click();
  await expect(weekGrid.locator(".day-column")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Show later days" })).toBeEnabled();

  await page.getByRole("button", { name: "Show later days" }).click();
  await expect(weekGrid.locator(".day-heading").first()).toContainText("Tue");
});
