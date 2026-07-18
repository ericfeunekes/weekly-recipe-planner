import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { assertViewportContained, captureAccessibleQaEvidence } from "../support/playwright-qa";

const evidenceDirectory = process.env.PLANNER_E2E_EVIDENCE_DIR;

for (const viewport of [
  { id: "phone", width: 320, height: 844 },
  { id: "tablet", width: 768, height: 1024 },
  { id: "desktop", width: 1280, height: 900 },
]) {
  test(`UI foundation fixture is accessible and contained on ${viewport.id}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/ui-foundation");

    await expect(page.getByRole("heading", { name: "Household controls" })).toBeVisible();
    const startCooking = page.getByRole("button", { name: "Start cooking" });
    const unavailable = page.getByRole("button", { name: "Unavailable" });
    await expect(startCooking).toBeVisible();
    await expect(unavailable).toBeDisabled();
    await page.keyboard.press("Tab");
    await expect(startCooking).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Save for later" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "End timer" })).toBeFocused();
    await assertViewportContained(page);

    if (evidenceDirectory) {
      await captureAccessibleQaEvidence({
        page,
        evidenceDirectory,
        scenarioId: "ui-foundation",
        viewportId: viewport.id,
      });
      return;
    }

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(axe.violations, axe.violations.map((violation) => violation.id).join(", ")).toEqual([]);
  });
}
