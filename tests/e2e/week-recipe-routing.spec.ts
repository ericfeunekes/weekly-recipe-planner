import { expect, test, type Page } from "@playwright/test";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";

async function resetPlanner(page: Page) {
  expect((await page.request.post(`${controlOrigin}/reset`)).ok()).toBe(true);
  await page.goto("/");
  const setup = page.getByRole("heading", { name: "Set up this planner once" });
  await expect(setup.or(page.getByText("Family dinner planner", { exact: true }))).toBeVisible();
  if (await setup.isVisible()) await page.getByRole("button", { name: "Start Fresh" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
}

test("Week opens the exact selected meal Recipe and preserves its URL through reload", async ({ page }) => {
  await resetPlanner(page);
  const card = page.locator(".week-view .meal-card:has(.meal-card-primary)").first();
  const title = await card.locator(".meal-title").innerText();
  await card.locator(".meal-card-primary").click();
  await expect(page).toHaveURL(/\/weeks\/2026-07-06\/recipes\//);
  await expect(page.getByRole("heading", { level: 1, name: "Recipe", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: `${title} recipe` })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/weeks\/2026-07-06$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/weeks\/2026-07-06\/recipes\//);
  await page.reload();
  await expect(page).toHaveURL(/\/weeks\/2026-07-06\/recipes\//);
  await expect(page.getByRole("region", { name: `${title} recipe` })).toBeVisible();
});

test("root keeps a current remembered Week and unavailable Recipes return to that Week", async ({ page }) => {
  await resetPlanner(page);
  await page.evaluate(() => window.localStorage.setItem("weekly-recipe-planner.last-valid-week", "2026-07-06"));
  await page.goto("/");
  await expect(page).toHaveURL(/\/weeks\/2026-07-06$/);
  await page.goto("/weeks/2026-07-06/recipes/missing");
  await expect(page).toHaveURL(/\/weeks\/2026-07-06$/);
  await expect(page.getByText("That recipe is unavailable for this week.", { exact: true })).toBeVisible();
});

test("legacy Day URL returns to Week without selecting a recipe", async ({ page }) => {
  await resetPlanner(page);
  await page.goto("/weeks/2026-07-06/day/2026-07-09");
  await expect(page).toHaveURL(/\/weeks\/2026-07-06$/);
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("direct and history Recipe locations stay intact while workspace reads fail, then recover", async ({ page }) => {
  await resetPlanner(page);
  await page.locator(".week-view .meal-card-primary").first().click();
  const recipeUrl = page.url();
  await page.goBack();
  const weekUrl = page.url();

  await page.route("**/api/workspace", async (route) => route.abort("failed"));
  await page.goto(recipeUrl);
  await expect(page).toHaveURL(recipeUrl);
  await expect(page.getByRole("heading", { name: "Planner unavailable", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(weekUrl);
  await page.goForward();
  await expect(page).toHaveURL(recipeUrl);

  await page.unroute("**/api/workspace");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page).toHaveURL(recipeUrl);
  await expect(page.getByRole("heading", { level: 1, name: "Recipe", exact: true })).toBeVisible();
});
