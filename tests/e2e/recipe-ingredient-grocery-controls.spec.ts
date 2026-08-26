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
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
}

test("output and leftover recipe rows do not expose grocery execution controls", async ({ page }) => {
  await resetPlanner(page);
  const response = await page.request.get("/api/workspace");
  expect(response.ok()).toBe(true);
  const workspace = await response.json() as {
    state: {
      activeWeekId: string;
      weeks: Array<{
        id: string;
        data: {
          meals: Array<{
            id: string;
            title: string;
            ingredients: Array<{
              id: string;
              source: string | null;
              ingredient: string;
              role: "weekly_requirement" | "output" | "leftover";
            }>;
          }>;
          groceries: Array<{ ingredientId: string }>;
        };
      }>;
    };
  };
  const activeWeek = workspace.state.weeks.find((week) => week.id === workspace.state.activeWeekId);
  const meal = activeWeek?.data.meals.find((candidate) => candidate.ingredients.length >= 3);
  expect(activeWeek).toBeTruthy();
  expect(meal).toBeTruthy();
  const [requirement, output, leftover] = meal!.ingredients;
  requirement.role = "weekly_requirement";
  requirement.source = null;
  requirement.ingredient = "fixture requirement";
  output.role = "output";
  output.source = null;
  output.ingredient = "fixture output";
  leftover.role = "leftover";
  leftover.source = null;
  leftover.ingredient = "fixture leftover";
  activeWeek!.data.groceries = activeWeek!.data.groceries.filter((grocery) =>
    grocery.ingredientId !== output.id && grocery.ingredientId !== leftover.id);

  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: workspace });
  });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  await page.locator(".meal-card").filter({ hasText: meal!.title }).getByRole("button", { name: /Open .* recipe/u }).click();

  const ingredients = page.locator(".meal-drawer .ingredient-list");
  await expect(ingredients.getByText("fixture requirement", { exact: false })).toBeVisible();
  await expect(ingredients.getByText("fixture output", { exact: false })).toBeVisible();
  await expect(ingredients.getByText("fixture leftover", { exact: false })).toBeVisible();
  await expect(ingredients.getByRole("checkbox", { name: "Check fixture requirement" })).toBeVisible();
  await expect(ingredients.getByRole("checkbox", { name: "Check fixture output" })).toHaveCount(0);
  await expect(ingredients.getByRole("checkbox", { name: "Check fixture leftover" })).toHaveCount(0);
});
