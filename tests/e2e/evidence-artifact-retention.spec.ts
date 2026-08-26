import { expect, test } from "@playwright/test";

import { captureAccessibleQaEvidence } from "../support/playwright-qa";

const enabled = process.env.PLANNER_E2E_ARTIFACT_RETENTION_PROBE === "1";

test("retains E2E failure artifacts without planner mutations", async ({ page }) => {
  test.skip(!enabled, "The artifact retention probe is opt-in.");
  const evidenceDirectory = process.env.PLANNER_E2E_EVIDENCE_DIR;
  if (!evidenceDirectory) throw new Error("The artifact retention probe requires PLANNER_E2E_EVIDENCE_DIR.");

  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  const planner = page.getByText("Family dinner planner");
  await expect(setup.or(planner)).toBeVisible();
  await captureAccessibleQaEvidence({
    page,
    evidenceDirectory,
    scenarioId: "artifact-retention",
    viewportId: "desktop-1280x900",
  });
  throw new Error("Intentional E2E artifact-retention probe failure.");
});
