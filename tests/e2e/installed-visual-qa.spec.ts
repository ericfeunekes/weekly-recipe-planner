import { expect, test, type Page } from "@playwright/test";

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

async function openMountedPlanner(page: Page): Promise<void> {
  await page.goto(publicBasePath);
  const bootstrap = page.getByRole("heading", { name: "Set up this planner once" });
  if (await bootstrap.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Start Fresh" }).click();
  }
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible({ timeout: 20_000 });
}

function navigation(page: Page) {
  return (page.viewportSize()?.width ?? 0) <= 840 ? page.locator(".mobile-nav") : page.locator(".view-nav");
}

test("mounted origin rejects its unmounted root", async ({ page }) => {
  test.skip(publicBasePath === "/", "Root-mounted QA has no unmounted alias to reject.");
  const response = await page.request.get("/");
  expect(response.status()).toBe(404);
});

for (const viewport of QA_VIEWPORTS) {
  test(`${fixture} ${viewport.id} is contained and accessible`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openMountedPlanner(page);

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

for (const viewport of [
  { id: "mobile-320x844", width: 320, height: 844 },
  { id: "desktop-1280x900", width: 1280, height: 900 },
]) {
  test(`${fixture} mounted navigation destinations are direct, reload-safe, contained, and accessible on ${viewport.id}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openMountedPlanner(page);
    const weekPath = new URL(page.url()).pathname;
    const selectionBefore = (await (await page.request.get(`${publicBasePath}api/codex/threads`)).json() as { selection: { threadId: string | null; revision: number } }).selection;
    const destinations = [
      { label: "Prep", heading: "Prep", path: `${weekPath}/prep`, id: "prep" },
      { label: "Groceries", heading: "Groceries", path: `${weekPath}/groceries`, id: "groceries" },
      { label: "Close out", heading: "Close out", path: `${weekPath}/closeout`, id: "closeout" },
    ];

    for (const destination of destinations) {
      await page.goto(destination.path);
      await expect(page).toHaveURL(destination.path);
      await expect(page.getByRole("heading", { level: 1, name: destination.heading, exact: true })).toBeVisible();
      await page.reload();
      await expect(page).toHaveURL(destination.path);
      await navigation(page).getByRole("button", { name: "Week", exact: true }).click();
      await expect(page).toHaveURL(weekPath);
      await navigation(page).getByRole("button", { name: destination.label, exact: true }).click();
      await expect(page).toHaveURL(destination.path);
      await expect(page.getByRole("heading", { level: 1, name: destination.heading, exact: true })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(weekPath);
      await page.goForward();
      await expect(page).toHaveURL(destination.path);
      await page.goto(publicBasePath);
      await expect(page).toHaveURL(destination.path);
      await captureAccessibleQaEvidence({
        page,
        evidenceDirectory,
        scenarioId: `${fixture.toLowerCase()}-navigation-${destination.id}`,
        viewportId: viewport.id,
      });
    }

    await navigation(page).getByRole("button", { name: "Groceries", exact: true }).click();
    await page.getByRole("radio", { name: "All", exact: true }).click();
    await expect(page).toHaveURL(destinations[1].path);

    await navigation(page).getByRole("button", { name: "Close out", exact: true }).click();
    await page.getByRole("textbox", { name: "What should next week remember?" }).fill("Mounted draft stays local.");
    await expect(page).toHaveURL(destinations[2].path);

    await navigation(page).getByRole("button", { name: "Week", exact: true }).click();
    await expect(page).toHaveURL(weekPath);
    await page.locator(".week-view .meal-card-primary").first().click();
    await expect(page).toHaveURL(/\/weeks\/[^/]+\/recipes\/[^/]+$/);
    const recipePath = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { level: 1, name: "Recipe", exact: true })).toBeVisible();
    await page.goto(recipePath);
    await expect(page).toHaveURL(recipePath);
    await page.reload();
    await expect(page).toHaveURL(recipePath);
    await page.goto(publicBasePath);
    await expect(page).toHaveURL(recipePath);
    const selectionAfter = (await (await page.request.get(`${publicBasePath}api/codex/threads`)).json() as { selection: { threadId: string | null; revision: number } }).selection;
    expect(selectionAfter).toEqual(selectionBefore);
    await captureAccessibleQaEvidence({
      page,
      evidenceDirectory,
      scenarioId: `${fixture.toLowerCase()}-navigation-recipe`,
      viewportId: viewport.id,
    });
  });
}
