import { expect, test } from "@playwright/test";

type SelectedCloneExpectation = {
  activeWeekId: string;
  plannerVersion: number;
  schemaVersion: number;
  syncRevision: number;
};

function selectedCloneExpectation(): SelectedCloneExpectation {
  const raw = process.env.PLANNER_E2E_SELECTED_CLONE_EXPECTED;
  if (raw === undefined) {
    throw new Error("Installed selected-clone Playwright requires its host expectation.");
  }
  const value = JSON.parse(raw) as Partial<SelectedCloneExpectation>;
  if (
    typeof value.activeWeekId !== "string" ||
    !Number.isSafeInteger(value.plannerVersion) || value.plannerVersion! < 0 ||
    !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion! < 1 ||
    !Number.isSafeInteger(value.syncRevision) || value.syncRevision! < 1
  ) {
    throw new Error("Installed selected-clone expectation is malformed.");
  }
  return value as SelectedCloneExpectation;
}

test("installed browser reads the exact initialized selected clone before reset", async ({ page }) => {
  const expected = selectedCloneExpectation();
  const workspaceResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/workspace" &&
    response.request().method() === "GET" && response.status() === 200);
  await page.goto("/");
  const response = await workspaceResponse;
  const workspace = await response.json() as {
    initialized: boolean;
    plannerVersion: number;
    schemaVersion: number;
    state: { activeWeekId: string };
    syncRevision: number;
  };
  expect(workspace).toMatchObject({
    initialized: true,
    plannerVersion: expected.plannerVersion,
    schemaVersion: expected.schemaVersion,
    syncRevision: expected.syncRevision,
    state: { activeWeekId: expected.activeWeekId },
  });
  await expect(page.getByText("Family dinner planner")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set up this planner once" })).toHaveCount(0);
  await expect(page.getByLabel("Selected week")).toHaveValue(expected.activeWeekId);
});
