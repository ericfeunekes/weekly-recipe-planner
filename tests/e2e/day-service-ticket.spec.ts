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
  test(`Week opens a selected non-today Day ticket on ${viewport.id}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await resetPlanner(page);
    const week = page.locator(".week-view");
    const dayAction = week.locator(".day-column:not(.today) .meal-card-primary").last();
    await expect(dayAction).toBeVisible();
    const dateLabel = (await dayAction.getAttribute("aria-label") ?? "").replace(/^Open /, "").replace(/ day$/, "");
    const mealCard = dayAction.locator("xpath=ancestor::article");
    const title = await mealCard.locator(".meal-title").innerText();

    await dayAction.click();

    await expect(page.getByRole("heading", { level: 1, name: "Day", exact: true })).toBeVisible();
    await expect(page.locator(".tonight-hero h2")).toHaveText(title);
    await expect(page.locator(".tonight-hero .eyebrow")).toContainText(dateLabel);
    await expect(page.getByRole("heading", { name: "Instructions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ingredients" })).toBeVisible();
    await assertViewportContained(page);
  });
}

test("Week Day controls remain clickable in a short desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 576 });
  await resetPlanner(page);
  const week = page.locator(".week-view");
  const dayAction = week.getByRole("button", { name: "Open Thursday, Jul 9 day" });
  await expect(dayAction).toBeVisible();
  await expect(dayAction).toBeEnabled();

  await dayAction.click();

  await expect(page.getByRole("heading", { level: 1, name: "Day", exact: true })).toBeVisible();
});

test("Day moves through the selected week without returning to Week", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await resetPlanner(page);
  await page.getByRole("button", { name: "Open Thursday, Jul 9 day" }).click();

  await expect(page.locator(".tonight-hero .eyebrow")).toContainText("Thursday, Jul 9");
  await page.getByRole("button", { name: "Open next day" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Day", exact: true })).toBeVisible();
  await expect(page.locator(".tonight-hero .eyebrow")).toContainText("Friday, Jul 10");
});
