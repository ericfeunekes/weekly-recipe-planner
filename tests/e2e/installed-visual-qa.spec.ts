import { expect, test } from "@playwright/test";

import {
  captureAccessibleQaEvidence,
  QA_VIEWPORTS,
} from "../support/playwright-qa";

const fixture = process.env.PLANNER_E2E_FIXTURE_EXPECTED;
const evidenceDirectory = process.env.PLANNER_E2E_EVIDENCE_DIR;
const publicBasePath = process.env.PLANNER_E2E_PUBLIC_BASE_PATH ?? "/";
if (!fixture || !["D4", "D7"].includes(fixture) || !evidenceDirectory) {
  throw new Error("Installed visual QA requires a closed fixture and evidence directory.");
}

test.describe.configure({ mode: "serial" });

test("mounted origin rejects its unmounted root", async ({ page }) => {
  test.skip(publicBasePath === "/", "Root-mounted QA has no unmounted alias to reject.");
  const response = await page.request.get("/");
  expect(response.status()).toBe(404);
});

for (const viewport of QA_VIEWPORTS) {
  test(`${fixture} ${viewport.id} is contained and accessible`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(publicBasePath);
    const bootstrap = page.getByRole("heading", { name: "Set up this planner once" });
    if (await bootstrap.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Start Fresh" }).click();
    }
    await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible({ timeout: 20_000 });

    if (viewport.width <= 841) {
      const openChat = page.getByRole("button", { name: "Open Codex" }).first();
      if (await openChat.isVisible().catch(() => false)) await openChat.click();
    }
    const composer = page.getByRole("textbox", { name: "Message Codex" });
    if (await composer.isVisible().catch(() => false)) await expect(composer).toBeVisible();
    await captureAccessibleQaEvidence({
      page,
      evidenceDirectory,
      scenarioId: fixture.toLowerCase(),
      viewportId: viewport.id,
    });
  });
}
