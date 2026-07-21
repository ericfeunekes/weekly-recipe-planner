import { expect, test, type Page } from "@playwright/test";
import { captureAccessibleQaEvidence } from "../support/playwright-qa";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";
const evidenceDirectory = `${process.cwd()}/outputs/qa/prep-combined`;

async function resetPlanner(page: Page): Promise<void> {
  const reset = await page.request.post(`${controlOrigin}/reset`);
  expect(reset.ok()).toBe(true);
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  const planner = page.getByText("Family dinner planner");
  await expect(setup.or(planner)).toBeVisible();
  if (await setup.isVisible()) await page.getByRole("button", { name: "Start Fresh" }).click();
  await expect(planner).toBeVisible();
}

test("combined Prep batches preview, fulfill sources independently, and expand with confirmation", async ({ page }) => {
  test.setTimeout(120_000);
  await resetPlanner(page);
  await page.getByRole("button", { name: "Prep", exact: true }).click();

  const prepDates = page.getByRole("tablist", { name: "Prep dates" });
  const sunday = prepDates.getByRole("tab", { name: /Sun, Jul 5/ });
  await sunday.click();
  const existing = page.getByTestId("prep-session-step").first();
  await expect(existing).toContainText("Coat the chicken with harissa");

  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole("button", { name: /Add recipe steps to/ }).click();
  const sources = page.getByRole("dialog", { name: "Recipe instructions" });
  await captureAccessibleQaEvidence({ page, evidenceDirectory, scenarioId: "prep-source", viewportId: "mobile-320x844" });
  const closeSources = sources.getByRole("button", { name: "Close recipe steps" });
  await closeSources.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await sources.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  const roast = sources.getByRole("button", {
    name: /Drag step 2 for Harissa chicken traybake: Roast the chicken, peppers, and chickpeas until cooked through\. onto a prep date/,
  });
  await roast.click();
  await sources.getByRole("button", { name: /Add selected recipe steps to Sun, Jul 5/ }).click();
  await expect(page.getByTestId("prep-session-step")).toHaveCount(2);

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole("button", { name: /Add recipe steps to/ }).click();
  const misoSources = page.getByRole("dialog", { name: "Recipe instructions" });
  await misoSources.getByRole("radio", { name: /Miso salmon rice bowls/ }).click();
  const glaze = misoSources.getByRole("button", { name: /Glaze the salmon and roast until just cooked/ });
  await glaze.click();
  await captureAccessibleQaEvidence({ page, evidenceDirectory, scenarioId: "prep-source", viewportId: "tablet-768x1024" });
  await misoSources.getByRole("button", { name: /Add selected recipe steps to Sun, Jul 5/ }).click();
  await expect(page.getByTestId("prep-session-step")).toHaveCount(3);

  const moveUp = page.getByRole("button", { name: /Move prep instruction .* up/ }).nth(1);
  await moveUp.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prep-session-step").first()).toContainText("Roast the chicken");
  const rowSelectors = page.getByRole("checkbox", { name: /^Select prep instruction/ });
  await rowSelectors.first().focus();
  await page.keyboard.press("Space");
  await rowSelectors.nth(2).focus();
  await page.keyboard.press("Space");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Combine selected" }).click();
  const dialog = page.getByRole("dialog", { name: "Combine selected instructions" });
  await expect(dialog).toContainText("Harissa chicken traybake");
  await expect(dialog).toContainText("Miso salmon rice bowls");
  await dialog.getByLabel("Combined prep instruction").fill("Prepare wording that will become stale.");
  let releaseFirstPreview: (() => void) | undefined;
  let previewRequestArrived: (() => void) | undefined;
  const firstPreviewArrived = new Promise<void>((resolve) => { previewRequestArrived = resolve; });
  let holdFirstPreview = true;
  await page.route("**/api/operations/preview", async (route) => {
    if (!holdFirstPreview) return route.continue();
    holdFirstPreview = false;
    const response = await route.fetch();
    previewRequestArrived?.();
    await new Promise<void>((resolve) => { releaseFirstPreview = resolve; });
    await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await firstPreviewArrived;
  await dialog.getByLabel("Combined prep instruction").fill("Prepare the shared chicken tray batch.");
  releaseFirstPreview?.();
  await expect(dialog.getByRole("button", { name: "Apply combined batch" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Preview ready");
  await expect(dialog.getByRole("status")).toContainText("Prep date: 2026-07-05");
  await expect(dialog.getByRole("status")).toContainText("Position:");
  await expect(dialog.getByRole("status")).toContainText("Source: Harissa chicken traybake");
  await expect(dialog.getByRole("status")).toContainText("Source: Miso salmon rice bowls");
  await expect(dialog.getByRole("status")).toContainText("Removed direct references from:");
  await captureAccessibleQaEvidence({ page, evidenceDirectory, scenarioId: "prep-combine", viewportId: "desktop-1280x900" });
  await dialog.getByRole("button", { name: "Apply combined batch" }).click();

  const combined = page.getByTestId("prep-combined-step");
  await expect(combined).toHaveCount(1);
  await expect(page.getByTestId("prep-session-step")).toHaveCount(1);
  await combined.getByRole("checkbox", { name: "Complete combined prep batch" }).click();
  await expect(combined.getByRole("checkbox", { name: "Reopen combined prep batch" })).toBeChecked();
  await expect(combined).toContainText("Prepared in batch");

  const restart = await page.request.post(`${controlOrigin}/restart`);
  expect(restart.ok()).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Family dinner planner")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Prep", exact: true }).click();
  await sunday.click();
  await expect(page.getByTestId("prep-combined-step")).toContainText("Prepared in batch");

  await page.getByRole("button", { name: /Add recipe steps to/ }).click();
  const ownedSources = page.getByRole("dialog", { name: "Recipe instructions" });
  await expect(ownedSources.getByRole("button", { name: /already assigned to prep/ })).toHaveCount(2);
  await expect(ownedSources.getByRole("button", { name: /already assigned to prep/ }).first()).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Add recipe steps to/ })).toBeFocused();

  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Open Thursday, Jul 9 day" }).click();
  await page.getByRole("button", { name: "Edit meal" }).click();
  const preparedMisoDialog = page.getByRole("dialog", { name: "Miso salmon rice bowls" });
  await expect(preparedMisoDialog.getByText("Prepared in batch", { exact: true })).toHaveCount(1);
  await expect(preparedMisoDialog.getByRole("checkbox", { name: /Complete step/ }).nth(1)).not.toBeChecked();
  await preparedMisoDialog.getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Open Tuesday, Jul 7 day" }).click();
  await page.getByRole("button", { name: "Edit meal" }).click();
  const mealDialog = page.getByRole("dialog", { name: "Harissa chicken traybake" });
  await expect(mealDialog.getByText("Prepared in batch", { exact: true })).toHaveCount(1);
  await expect(mealDialog.getByRole("checkbox", { name: /Complete step/ })).toHaveCount(2);
  await expect(mealDialog.getByRole("checkbox", { name: /Complete step/ }).first()).not.toBeChecked();
  const roastStep = mealDialog.locator(".instruction-step").filter({ hasText: "Roast the chicken" });
  await roastStep.getByText("Edit instruction", { exact: true }).click();
  await roastStep.getByRole("textbox", { name: /Instruction text/ }).fill("Roast the chicken, peppers, and chickpeas until cooked through, then rest.");
  await roastStep.getByRole("button", { name: /Save step/ }).click();
  await expect(mealDialog.getByText("Prepared in batch", { exact: true })).toHaveCount(0);
  await mealDialog.getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("button", { name: "Open Thursday, Jul 9 day" }).click();
  await page.getByRole("button", { name: "Edit meal" }).click();
  const misoDialog = page.getByRole("dialog", { name: "Miso salmon rice bowls" });
  await expect(misoDialog.getByText("Prepared in batch", { exact: true })).toHaveCount(0);
  await expect(misoDialog.getByRole("checkbox", { name: /Complete step/ })).toHaveCount(2);
  await expect(misoDialog.getByRole("checkbox", { name: /Complete step/ }).nth(1)).not.toBeChecked();
  await misoDialog.getByRole("button", { name: "Close", exact: true }).last().click();

  await page.getByRole("button", { name: "Prep", exact: true }).click();
  await sunday.click();
  const reviewBatch = page.getByTestId("prep-combined-step");
  await expect(reviewBatch).toContainText("Needs review");
  await expect(reviewBatch.getByRole("checkbox", { name: "Complete combined prep batch" })).toBeDisabled();
  await reviewBatch.getByRole("button", { name: "Edit" }).click();
  await reviewBatch.getByRole("button", { name: "Save batch" }).click();
  await expect(reviewBatch).not.toContainText("Needs review");
  await reviewBatch.getByRole("checkbox", { name: "Complete combined prep batch" }).click();
  await expect(reviewBatch).toContainText("Prepared in batch");
  await page.getByTestId("prep-combined-step").getByRole("button", { name: "Expand" }).click();
  const discard = page.getByRole("dialog", { name: "Discard prepared batch?" });
  await expect(discard).toContainText("canonical recipe completion remains unchanged");
  await expect(discard.getByRole("status")).toContainText("Preview ready");
  await expect(discard.getByRole("status")).toContainText("Prep date:");
  await page.setViewportSize({ width: 320, height: 844 });
  await captureAccessibleQaEvidence({ page, evidenceDirectory, scenarioId: "prep-discard", viewportId: "mobile-320x844" });
  await discard.getByRole("button", { name: "Discard and continue" }).click();
  await expect(page.getByTestId("prep-combined-step")).toHaveCount(0);
  await expect(page.getByTestId("prep-session-step")).toHaveCount(3);

  await page.getByTitle("Change history").click();
  const history = page.getByRole("dialog", { name: "Recent changes" });
  await history.getByRole("button", { name: "Undo latest change" }).click();
  await expect(page.getByTestId("prep-combined-step")).toHaveCount(1);
  await expect(page.getByTestId("prep-combined-step").getByRole("checkbox", { name: "Reopen combined prep batch" })).toBeChecked();
});
