import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { assertViewportContained } from "../support/playwright-qa";

const controlOrigin = process.env.PLANNER_E2E_CONTROL_ORIGIN ?? "http://127.0.0.1:8878";

type Meal = {
  id: string;
  date: string;
  title: string;
  status: string;
  leftoverNote: string;
};

type Workspace = {
  plannerVersion: number;
  state: {
    activeWeekId: string;
    weeks: Array<{
      id: string;
      data: {
        meals: Meal[];
        leftovers: Array<{
          id: string;
          sourceMealId: string;
          label: string;
          portions: number;
          state: string;
          assignedDate?: string;
          assignedMealId?: string;
        }>;
      };
    }>;
  };
};

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

async function workspace(page: Page): Promise<Workspace> {
  const response = await page.request.get("/api/workspace");
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Workspace>;
}

async function command(
  page: Page,
  plannerVersion: number,
  value: Record<string, unknown>,
): Promise<number> {
  const response = await page.request.post("/api/commands", {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      requestId: crypto.randomUUID(),
      basePlannerVersion: plannerVersion,
      command: value,
    },
  });
  if (!response.ok()) throw new Error(`Planner command failed: ${await response.text()}`);
  const body = await response.json() as {
    decision: { status: string; plannerVersion: number };
  };
  expect(body.decision.status).toBe("accepted");
  return body.decision.plannerVersion;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function recipePath(weekId: string, mealId: string): string {
  return `/weeks/${encodeURIComponent(weekId)}/recipes/${encodeURIComponent(mealId)}`;
}

test("assigned leftovers survive shared-client readback and authority restart before consumption", async ({ browser, page }) => {
  test.setTimeout(120_000);
  await resetPlanner(page);
  const initial = await workspace(page);
  const week = initial.state.weeks.find(({ id }) => id === initial.state.activeWeekId)!;
  const targetDate = addDays(week.id, 6);
  const source = week.data.meals.find((meal) => meal.leftoverNote && meal.date < targetDate)!;
  expect(source).toBeTruthy();
  const displacedMeals = week.data.meals
    .filter((meal) => meal.date === targetDate)
    .map(({ id, status }) => ({ id, status }));

  const cookedVersion = await command(page, initial.plannerVersion, {
    type: "updateMealStatus",
    weekId: week.id,
    mealId: source.id,
    status: "cooked",
  });
  const cookedReadback = await workspace(page);
  const leftoverId = cookedReadback.state.weeks.find(({ id }) => id === week.id)!.data.leftovers
    .find(({ sourceMealId, state }) => sourceMealId === source.id && state === "available")?.id;
  expect(leftoverId).toEqual(expect.any(String));
  if (!leftoverId) throw new Error("Cooking the source meal did not create an available leftover.");
  await command(page, cookedVersion, {
    type: "assignLeftover",
    weekId: week.id,
    leftoverId,
    targetDate,
  });
  const localAssignedReadback = await workspace(page);
  const assignedMealId = localAssignedReadback.state.weeks.find(({ id }) => id === week.id)!.data.leftovers
    .find(({ id }) => id === leftoverId)?.assignedMealId;
  expect(assignedMealId).toEqual(expect.any(String));
  if (!assignedMealId) throw new Error("Assigning the leftover did not create a destination meal.");

  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  await peer.goto("/");
  await expect(peer.getByText("Family dinner planner")).toBeVisible();
  await peer.evaluate(() => window.dispatchEvent(new Event("focus")));
  const unrelatedMeal = localAssignedReadback.state.weeks.find(({ id }) => id === week.id)!.data.meals
    .find(({ id }) => id !== assignedMealId)!;
  await peer.goto(recipePath(week.id, unrelatedMeal.id));
  await expect(peer.getByLabel("Assigned leftovers")).toHaveCount(0);
  await expect(peer.getByRole("button", { name: /Mark .* leftovers eaten/u })).toHaveCount(0);

  await peer.goto(recipePath(week.id, assignedMealId));
  await expect(peer.getByText(`${source.title}`, { exact: true })).toBeVisible();
  await expect(peer.getByText(/portions are assigned to this meal\./u)).toBeVisible();
  await expect(peer.getByRole("button", { name: /Mark .* leftovers eaten/u })).toBeVisible();

  const assignedReadback = await workspace(peer);
  const assignedWeek = assignedReadback.state.weeks.find(({ id }) => id === week.id)!;
  expect(assignedWeek.data.leftovers.find(({ id }) => id === leftoverId)).toMatchObject({
    state: "assigned",
    assignedDate: targetDate,
    assignedMealId,
  });
  expect(assignedWeek.data.meals.filter(({ id }) => displacedMeals.some((meal) => meal.id === id))
    .map(({ id, status }) => ({ id, status }))).toEqual(displacedMeals);
  expect(assignedWeek.data.meals.find(({ id }) => id === assignedMealId)).toMatchObject({
    date: targetDate,
    status: "leftover",
  });

  const restart = await page.request.post(`${controlOrigin}/restart`);
  expect(restart.ok()).toBe(true);
  await Promise.all([
    page.reload({ waitUntil: "domcontentloaded" }),
    peer.reload({ waitUntil: "domcontentloaded" }),
  ]);
  await expect(page.getByText("Family dinner planner")).toBeVisible({ timeout: 20_000 });
  await expect(peer.getByText("Family dinner planner")).toBeVisible({ timeout: 20_000 });
  const restarted = await workspace(peer);
  const restartedWeek = restarted.state.weeks.find(({ id }) => id === week.id)!;
  expect(restartedWeek.data.leftovers.find(({ id }) => id === leftoverId)).toMatchObject({
    state: "assigned",
    assignedDate: targetDate,
    assignedMealId,
  });

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    await peer.setViewportSize(viewport);
    await expect(peer.getByLabel("Assigned leftovers")).toBeVisible();
    await expect(peer.getByRole("button", { name: /Mark .* leftovers eaten/u })).toBeVisible();
    await assertViewportContained(peer);
    const accessibility = await new AxeBuilder({ page: peer })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations, accessibility.violations.map((violation) => violation.id).join(", ")).toEqual([]);
  }

  const consumedResponse = peer.waitForResponse((response) => {
    if (!response.url().endsWith("/api/commands") || response.request().method() !== "POST") return false;
    return (response.request().postDataJSON() as { command?: { type?: string } }).command?.type === "consumeLeftover";
  });
  await peer.getByRole("button", { name: /Mark .* leftovers eaten/u }).click();
  expect((await consumedResponse).status()).toBe(200);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const consumed = await workspace(page);
  const consumedWeek = consumed.state.weeks.find(({ id }) => id === week.id)!;
  expect(consumedWeek.data.leftovers.find(({ id }) => id === leftoverId)).toMatchObject({
    state: "consumed",
  });
  expect(consumedWeek.data.leftovers.find(({ id }) => id === leftoverId)).not.toHaveProperty("assignedDate");
  expect(consumedWeek.data.leftovers.find(({ id }) => id === leftoverId)).not.toHaveProperty("assignedMealId");
  expect(consumedWeek.data.meals.find(({ id }) => id === assignedMealId)?.status).toBe("cooked");
  expect(consumedWeek.data.meals.filter(({ id }) => displacedMeals.some((meal) => meal.id === id))
    .map(({ id, status }) => ({ id, status }))).toEqual(displacedMeals);
  await peerContext.close();
});

test("assigned leftover Recipe respects conflict and archived route guards", async ({ browser, page }) => {
  test.setTimeout(120_000);
  await resetPlanner(page);
  const initial = await workspace(page);
  const week = initial.state.weeks.find(({ id }) => id === initial.state.activeWeekId)!;
  const targetDate = addDays(week.id, 6);
  const source = week.data.meals.find((meal) => meal.leftoverNote && meal.date < targetDate)!;
  const cookedVersion = await command(page, initial.plannerVersion, {
    type: "updateMealStatus", weekId: week.id, mealId: source.id, status: "cooked",
  });
  const cooked = await workspace(page);
  const leftoverId = cooked.state.weeks.find(({ id }) => id === week.id)!.data.leftovers
    .find(({ sourceMealId, state }) => sourceMealId === source.id && state === "available")?.id;
  if (!leftoverId) throw new Error("Cooking the source meal did not create an available leftover.");
  await command(page, cookedVersion, { type: "assignLeftover", weekId: week.id, leftoverId, targetDate });
  const assigned = await workspace(page);
  const assignedMealId = assigned.state.weeks.find(({ id }) => id === week.id)!.data.leftovers
    .find(({ id }) => id === leftoverId)?.assignedMealId;
  if (!assignedMealId) throw new Error("Assigning the leftover did not create a destination meal.");

  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  await peer.goto(recipePath(week.id, assignedMealId));
  await expect(peer.getByRole("button", { name: /Mark .* leftovers eaten/u })).toBeVisible();
  const bumpedVersion = await command(page, assigned.plannerVersion, {
    type: "captureWeekLesson", weekId: week.id, weekLesson: "Conflict fixture update.",
  });
  await peer.getByRole("button", { name: /Mark .* leftovers eaten/u }).click();
  await expect(peer.locator(".meal-drawer").getByText(/Someone else changed the plan\./u)).toBeVisible();
  const afterConflict = await workspace(peer);
  expect(afterConflict.state.weeks.find(({ id }) => id === week.id)!.data.leftovers.find(({ id }) => id === leftoverId))
    .toMatchObject({ state: "assigned", assignedMealId });

  await command(page, bumpedVersion, { type: "archiveWeek", weekId: week.id });
  await peer.goto(recipePath(week.id, assignedMealId));
  await expect(peer.getByRole("heading", { level: 1, name: "Week", exact: true })).toBeVisible();
  await expect(peer.locator(".meal-drawer")).toHaveCount(0);
  await expect(peer.getByRole("button", { name: /Mark .* leftovers eaten/u })).toHaveCount(0);
  await peerContext.close();
});
