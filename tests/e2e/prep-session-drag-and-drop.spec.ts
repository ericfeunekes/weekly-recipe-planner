import { expect, test, type Page } from "@playwright/test";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";

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

test("batch prep uses one bounded date strip, supports full-row drag, and can move selected work to an earlier week", async ({ page }) => {
  await resetPlanner(page);
  await page.getByRole("button", { name: "Prep", exact: true }).click();

  const prepDates = page.getByRole("tablist", { name: "Prep dates" });
  await expect(prepDates.getByRole("tab")).toHaveCount(7);
  await expect(page.getByRole("navigation", { name: "Batch prep planned days" })).toHaveCount(0);
  const wednesday = prepDates.getByRole("tab", { name: "Open empty prep date Wed, Jul 8" });
  const thursday = prepDates.getByRole("tab", { name: "Open empty prep date Thu, Jul 9" });
  await expect(wednesday).toBeVisible();
  await expect(thursday).toBeVisible();

  await page.getByRole("button", { name: /Add recipe steps to/ }).click();
  const recipeSteps = page.getByRole("dialog", { name: "Recipe instructions" });
  const firstSourceStep = recipeSteps.getByRole("button", {
    name: /Drag step 1 for Harissa chicken traybake: Coat the chicken with harissa and refrigerate\. onto a prep date/,
  });
  const secondSourceStep = recipeSteps.getByRole("button", {
    name: /Drag step 2 for Harissa chicken traybake: Roast the chicken, peppers, and chickpeas until cooked through\. onto a prep date/,
  });
  await expect(firstSourceStep).toBeVisible();
  await expect(secondSourceStep).toBeVisible();
  await firstSourceStep.click();
  await secondSourceStep.click({ modifiers: ["Shift"] });
  await expect(recipeSteps.getByText("2 selected", { exact: true })).toBeVisible();

  await secondSourceStep.dragTo(wednesday);
  await expect(wednesday).toHaveAttribute("aria-selected", "true");
  await recipeSteps.getByRole("button", { name: "Close recipe steps", exact: true }).click();
  await expect(recipeSteps).toHaveCount(0);
  const destinationRows = page.getByTestId("prep-session-step");
  await expect(destinationRows).toHaveCount(2);
  await expect(wednesday).toHaveAccessibleName("Open 2 prep steps on Wed, Jul 8");

  const insertionTarget = destinationRows.nth(1);
  const targetBounds = await insertionTarget.boundingBox();
  expect(targetBounds).not.toBeNull();
  const dragData = await page.evaluateHandle(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-prep-date-entries", '["test-entry"]');
    return dataTransfer;
  });
  await insertionTarget.dispatchEvent("dragover", {
    clientY: targetBounds!.y + 4,
    dataTransfer: dragData,
  });
  const insertionMarker = page.locator(".prep-insertion-indicator");
  await expect(insertionMarker).toHaveCount(1);
  await expect(insertionMarker).toHaveCSS("border-top-width", "4px");

  await destinationRows.first().dragTo(thursday);
  await expect(thursday).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("prep-session-step")).toHaveCount(1);

  await page.getByRole("button", { name: "Select all 1 prep step", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("1 selected");
  const moveTarget = page.getByLabel("Move selected prep steps to");
  await moveTarget.fill("2026-06-29");
  await page.getByRole("button", { name: "Move selected prep steps", exact: true }).click();
  await expect(prepDates.getByRole("tab").first()).toHaveAccessibleName("Open 1 prep step on Mon, Jun 29");
  const transferredRows = page.getByTestId("prep-session-step");
  await expect(transferredRows).toHaveCount(1);
});
