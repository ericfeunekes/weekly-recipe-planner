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

test("batch prep shows planned days, moves a multi-selection, and exposes a thick insertion marker", async ({ page }) => {
  await resetPlanner(page);
  await page.getByRole("button", { name: "Prep", exact: true }).click();

  const sessions = page.getByRole("tablist", { name: "Prep sessions" });
  const sourceSession = sessions.getByRole("tab").first();
  const destinationSession = sessions.getByRole("tab").nth(1);
  await expect(sourceSession).toBeVisible();
  await expect(destinationSession).toBeVisible();
  const plannedDays = page.getByRole("navigation", { name: "Batch prep planned days" });
  await expect(plannedDays).toBeVisible();
  await expect(plannedDays.getByRole("button")).toHaveCount(2);

  await page.getByRole("button", { name: /Add recipe steps to/ }).click();
  const recipeSteps = page.getByRole("dialog", { name: "Recipe instructions" });
  const firstSourceStep = recipeSteps.getByRole("button", {
    name: /Drag step 1 for Harissa chicken traybake: Coat the chicken with harissa and refrigerate\. into a prep session/,
  });
  const secondSourceStep = recipeSteps.getByRole("button", {
    name: /Drag step 2 for Harissa chicken traybake: Roast the chicken, peppers, and chickpeas until cooked through\. into a prep session/,
  });
  await expect(firstSourceStep).toBeVisible();
  await expect(secondSourceStep).toBeVisible();
  await firstSourceStep.click();
  await secondSourceStep.click({ modifiers: ["Shift"] });
  await expect(recipeSteps.getByText("2 selected", { exact: true })).toBeVisible();

  await secondSourceStep.dragTo(destinationSession);
  await expect(destinationSession).toHaveAttribute("aria-selected", "true");
  await recipeSteps.getByRole("button", { name: "Close recipe steps", exact: true }).click();
  await expect(recipeSteps).toHaveCount(0);
  const destinationRows = page.getByTestId("prep-session-step");
  await expect(destinationRows).toHaveCount(3);

  await page.getByRole("button", { name: "Select all 3 prep steps", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("3 selected");

  await page.getByLabel("Prep session name").fill("Transfer check");
  await page.getByLabel("Prep session date").fill("2026-07-10");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const transferSession = sessions.getByRole("tab", { name: /Transfer check/ });
  await expect(transferSession).toBeVisible();

  const moveTarget = page.getByLabel("Move selected prep steps to");
  await moveTarget.selectOption({ label: "Fri, Jul 10" });
  await page.getByRole("button", { name: "Move selected prep steps", exact: true }).click();
  await expect(transferSession).toHaveAttribute("aria-selected", "true");
  const transferredRows = page.getByTestId("prep-session-step");
  await expect(transferredRows).toHaveCount(3);

  const insertionTarget = transferredRows.nth(1);
  const targetBounds = await insertionTarget.boundingBox();
  expect(targetBounds).not.toBeNull();
  const dragData = await page.evaluateHandle(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("application/x-prep-session-entries", '["test-entry"]');
    return dataTransfer;
  });
  await insertionTarget.dispatchEvent("dragover", {
    clientY: targetBounds!.y + 4,
    dataTransfer: dragData,
  });
  const insertionMarker = page.locator(".prep-insertion-indicator");
  await expect(insertionMarker).toHaveCount(1);
  await expect(insertionMarker).toHaveCSS("border-top-width", "4px");
});
