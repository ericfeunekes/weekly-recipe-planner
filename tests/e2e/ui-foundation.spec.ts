import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { assertViewportContained } from "../support/playwright-qa";

for (const viewport of [
  { id: "phone", width: 320, height: 844 },
  { id: "tablet", width: 768, height: 1024 },
  { id: "desktop", width: 1280, height: 900 },
]) {
  test(`UI foundation fixture is accessible and contained on ${viewport.id}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/__ui-foundation");

    await expect(page.getByRole("heading", { name: "Household controls" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start cooking" })).toBeVisible();
    await page.getByRole("button", { name: "Start cooking" }).focus();
    await expect(page.getByRole("button", { name: "Start cooking" })).toBeFocused();
    await assertViewportContained(page);

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(axe.violations, axe.violations.map((violation) => violation.id).join(", ")).toEqual([]);
  });
}

test("UI foundation dialogs retain an accessible name", async ({ page }) => {
  await page.goto("/__ui-foundation");
  await page.getByRole("button", { name: "Open dialog" }).click();
  await expect(page.getByRole("dialog", { name: "Recipe note" })).toBeVisible();
});
