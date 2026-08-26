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

type RouteFixture = {
  state: {
    activeWeekId: string | null;
    weeks: Array<{
      id: string;
      data: {
        meals: Array<{ id: string; title: string; date: string; ingredients: Array<{ id: string; [key: string]: unknown }>; instructions: Array<{ id: string; [key: string]: unknown }>; [key: string]: unknown }>;
        groceries: Array<{ id: string; mealId: string; ingredientId: string; [key: string]: unknown }>;
        prepSessions: Array<{ steps: Array<{ stepId?: string; [key: string]: unknown }> }>;
      };
    }>;
  };
};

function threeSameDateFixture(workspace: RouteFixture) {
  const fixture = structuredClone(workspace);
  const week = fixture.state.weeks.find((candidate) => candidate.id === fixture.state.activeWeekId)!;
  const source = week.data.meals.find((meal) => week.data.groceries.some((grocery) => grocery.mealId === meal.id))!;
  const meals = [1, 2, 3].map((index) => {
    const meal = structuredClone(source);
    meal.id = `route-meal-${index}`;
    meal.title = `Route meal ${index}`;
    meal.date = source.date;
    meal.ingredients = meal.ingredients.map((ingredient: Record<string, unknown>, ingredientIndex: number) => ({ ...ingredient, id: `route-ingredient-${index}-${ingredientIndex}` }));
    meal.instructions = meal.instructions.map((step: Record<string, unknown>, stepIndex: number) => ({ ...step, id: `route-step-${index}-${stepIndex}` }));
    return meal;
  });
  week.data.meals = [...week.data.meals.filter((meal) => meal.id !== source.id), ...meals];
  const sourceGroceries = week.data.groceries.filter((grocery) => grocery.mealId === source.id);
  week.data.groceries = [
    ...week.data.groceries.filter((grocery) => grocery.mealId !== source.id),
    ...meals.flatMap((meal) => sourceGroceries.map((grocery, index) => ({ ...grocery, id: `route-grocery-${meal.id}-${index}`, mealId: meal.id, ingredientId: meal.ingredients[index]?.id ?? meal.ingredients[0].id }))),
  ];
  const directStep = week.data.prepSessions.flatMap((session) => session.steps).find((entry) => "stepId" in entry);
  if (directStep) directStep.stepId = meals[1].instructions[0].id;
  return { fixture, weekId: week.id, meals };
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
  await expect.poll(() => page.locator(".day-column[tabindex='-1']").evaluate((column) => document.activeElement === column)).toBe(true);
});

test("Groceries direct URL, reload, and history retain the selected Week without routing local controls", async ({ page }) => {
  await resetPlanner(page);
  await page.getByRole("button", { name: "Groceries", exact: true }).click();
  await expect(page).toHaveURL("/weeks/2026-07-06/groceries");
  await expect(page.getByRole("heading", { level: 1, name: "Groceries", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "All", exact: true }).click();
  await page.locator(".grocery-row .grocery-item-copy").first().click({ position: { x: 1, y: 1 } });
  await expect(page.getByTestId("grocery-selection-toolbar")).toBeVisible();
  await expect(page).toHaveURL("/weeks/2026-07-06/groceries");
  await page.reload();
  await expect(page).toHaveURL("/weeks/2026-07-06/groceries");
  await expect(page.getByRole("radio", { name: "To buy", exact: true })).toBeChecked();
  await expect(page.getByTestId("grocery-selection-toolbar")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/weeks\/2026-07-06$/);
  await expect(page.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL("/weeks/2026-07-06/groceries");
  await expect(page.getByRole("heading", { level: 1, name: "Groceries", exact: true })).toBeVisible();
});

test("a requested Groceries URL remains until workspace authority is available", async ({ page }) => {
  await resetPlanner(page);
  const groceriesUrl = "/weeks/2026-07-06/groceries";
  await page.route("**/api/workspace", async (route) => route.abort("failed"));
  await page.goto(groceriesUrl);
  await expect(page).toHaveURL(groceriesUrl);
  await expect(page.getByRole("heading", { name: "Planner unavailable", exact: true })).toBeVisible();
  await page.unroute("**/api/workspace");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page).toHaveURL(groceriesUrl);
  await expect(page.getByRole("heading", { level: 1, name: "Groceries", exact: true })).toBeVisible();
});

test("D4 source links keep three same-date meal identities and Recipe context exact", async ({ page }) => {
  await resetPlanner(page);
  const workspace = await (await page.request.get("/api/workspace")).json() as RouteFixture;
  const { fixture, weekId, meals } = threeSameDateFixture(workspace);
  await page.route("**/api/workspace", async (route) => route.fulfill({ json: fixture }));
  await page.reload();

  for (const meal of meals) {
    await page.getByRole("article", { name: new RegExp(`^${meal.title} on `) }).getByRole("button", { name: new RegExp(`Open ${meal.title} recipe`) }).click();
    await expect(page).toHaveURL(`/weeks/${weekId}/recipes/${meal.id}`);
    await page.getByTitle("Back to Week").click();
  }

  await page.getByRole("button", { name: "Prep", exact: true }).click();
  const prepSource = page.getByTestId("prep-session-step").first();
  await prepSource.getByRole("button", { name: /More options for step/ }).click();
  await prepSource.getByRole("menuitem", { name: meals[1].title, exact: true }).click();
  await expect(page).toHaveURL(`/weeks/${weekId}/recipes/${meals[1].id}`);
  await page.getByTitle("Back to Week").click();

  await page.getByRole("button", { name: "Groceries", exact: true }).click();
  await page.getByRole("radio", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: meals[2].title, exact: true }).first().click();
  await expect(page).toHaveURL(`/weeks/${weekId}/recipes/${meals[2].id}`);
  await page.getByTitle("Back to Week").click();

  await page.getByRole("button", { name: "Week", exact: true }).click();
  await page.getByRole("article", { name: new RegExp(`^${meals[0].title} on `) }).getByRole("button", { name: new RegExp(`Open ${meals[0].title} recipe`) }).click();
  const step = page.locator(".meal-drawer .instruction-step").first();
  await step.getByRole("button", { name: /Add Prep note for step/ }).click();
  await step.getByRole("textbox", { name: /Prep note or Codex request for step/ }).fill("Exact route context");
  await step.getByRole("button", { name: "Ask Codex" }).click();
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/codex/turns/send") && request.method() === "POST");
  await page.getByRole("button", { name: "Send to Codex" }).click();
  expect((await sent).postData()).toContain(`[Planner recipe context: weekId=${weekId}; mealId=${meals[0].id}; stepId=${meals[0].instructions[0].id}]`);
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

  await page.unroute("**/api/workspace");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page).toHaveURL(recipeUrl);
  await expect(page.getByRole("heading", { level: 1, name: "Recipe", exact: true })).toBeVisible();

  await page.route("**/api/workspace", async (route) => route.abort("failed"));
  await page.goBack();
  await expect(page).toHaveURL(weekUrl);
  await page.goForward();
  await expect(page).toHaveURL(recipeUrl);
  await page.unroute("**/api/workspace");
});
