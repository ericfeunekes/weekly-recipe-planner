import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { assertViewportContained } from "../support/playwright-qa";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";

async function resetPlanner(page: Page) {
  const reset = await page.request.post(`${controlOrigin}/reset`);
  expect(reset.ok()).toBe(true);
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  const planner = page.getByText("Family dinner planner");
  await expect(setup.or(planner)).toBeVisible();
  if (await setup.isVisible()) await page.getByRole("button", { name: "Start Fresh" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
}

for (const viewport of [{ id: "phone", width: 390, height: 844 }, { id: "desktop", width: 1280, height: 900 }]) {
  test(`Week has no Prep affordance on ${viewport.id}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await resetPlanner(page);
    const week = page.locator(".week-view");
    await expect(week.locator(".day-prep-indicator")).toHaveCount(0);
    await expect(week.getByRole("button", { name: /^Prep/ })).toHaveCount(0);
    await expect(week.getByText(/prep/i)).toHaveCount(0);
    if (viewport.id === "phone") {
      await expect(week.getByRole("button", { name: /^Groceries/ })).toBeVisible();
    } else {
      await expect(week.locator(".meal-card").first()).toBeVisible();
    }
    await assertViewportContained(page);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations, axe.violations.map((item) => item.id).join(", ")).toEqual([]);
  });
}
