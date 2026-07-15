import { expect, test } from "@playwright/test";

import {
  captureAccessibleQaEvidence,
  QA_VIEWPORTS,
} from "../support/playwright-qa";

const fixture = process.env.PLANNER_E2E_FIXTURE_EXPECTED;
const evidenceDirectory = process.env.PLANNER_E2E_EVIDENCE_DIR;
if (!fixture || !["D4", "D7"].includes(fixture) || !evidenceDirectory) {
  throw new Error("Installed visual QA requires a closed fixture and evidence directory.");
}

test.describe.configure({ mode: "serial" });

for (const viewport of QA_VIEWPORTS) {
  test(`${fixture} ${viewport.id} is contained and accessible`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    const bootstrap = page.getByRole("heading", { name: "Set up this planner once" });
    if (await bootstrap.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Start Fresh" }).click();
    }
    await expect(page.getByText("Family dinner planner")).toBeVisible();

    if (viewport.width <= 841) {
      const openChat = page.getByRole("button", { name: "ChatGPT" }).first();
      if (await openChat.isVisible().catch(() => false)) await openChat.click();
    }
    await expect(page.getByRole("textbox", { name: "Message ChatGPT" })).toBeVisible();
    await captureAccessibleQaEvidence({
      page,
      evidenceDirectory,
      scenarioId: fixture.toLowerCase(),
      viewportId: viewport.id,
    });
  });
}
