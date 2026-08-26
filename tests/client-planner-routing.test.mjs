import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import {
  LAST_VALID_WEEK_STORAGE_KEY,
  closeoutPath,
  groceriesPath,
  parseRememberedPlannerLocation,
  parsePlannerLocation,
  plannerLocationPath,
  prepPath,
  recipePath,
  rememberedPlannerLocation,
  resolvePlannerLocation,
  serializeRememberedPlannerLocation,
  weekPath,
} from "../app/planner-routing.ts";

function fixture() {
  let sequence = 0;
  const state = createCanonicalSeed({
    now: Date.parse("2026-07-07T18:00:00-03:00"),
    createId(prefix) { sequence += 1; return `${prefix}-${sequence}`; },
  });
  const week = structuredClone(state.weeks[0]);
  const duplicate = structuredClone(week.data.meals[0]);
  duplicate.id = "second-meal-same-day";
  duplicate.title = week.data.meals[0].title;
  week.data.meals.push(duplicate);
  return week;
}

test("Week and Recipe locations preserve opaque meal identity", () => {
  const week = fixture();
  const first = week.data.meals[0];
  const second = week.data.meals.at(-1);
  assert.equal(weekPath(week.id), `/weeks/${week.id}`);
  assert.equal(recipePath(week.id, second.id), `/weeks/${week.id}/recipes/${second.id}`);
  assert.deepEqual(parsePlannerLocation(recipePath(week.id, second.id)), { kind: "recipe", weekId: week.id, mealId: second.id });
  assert.equal(resolvePlannerLocation(parsePlannerLocation(recipePath(week.id, second.id)), [week], week.id).mealId, second.id);
  assert.notEqual(second.id, first.id);
});

test("Closeout locations preserve the selected Week identity", () => {
  const week = fixture();
  assert.equal(closeoutPath(week.id), `/weeks/${week.id}/closeout`);
  assert.deepEqual(parsePlannerLocation(closeoutPath(week.id)), { kind: "closeout", weekId: week.id });
  const resolved = resolvePlannerLocation(parsePlannerLocation(closeoutPath(week.id)), [week], week.id);
  assert.equal(resolved.kind, "closeout");
  assert.equal(resolved.week.id, week.id);
  const archived = structuredClone(week);
  archived.status = "archived";
  assert.equal(resolvePlannerLocation(parsePlannerLocation(closeoutPath(archived.id)), [archived], archived.id).kind, "closeout");
});

test("Prep locations preserve the selected Week, including archived weeks", () => {
  const week = fixture();
  assert.equal(prepPath(week.id), `/weeks/${week.id}/prep`);
  assert.deepEqual(parsePlannerLocation(prepPath(week.id)), { kind: "prep", weekId: week.id });
  const resolved = resolvePlannerLocation(parsePlannerLocation(prepPath(week.id)), [week], week.id);
  assert.equal(resolved.kind, "prep");
  assert.equal(resolved.week.id, week.id);

  const archived = structuredClone(week);
  archived.status = "archived";
  assert.equal(resolvePlannerLocation(parsePlannerLocation(prepPath(archived.id)), [archived], archived.id).kind, "prep");
});

test("Groceries location preserves its selected Week, including archived records", () => {
  const week = fixture();
  assert.equal(groceriesPath(week.id), `/weeks/${week.id}/groceries`);
  assert.deepEqual(parsePlannerLocation(groceriesPath(week.id)), { kind: "groceries", weekId: week.id });
  assert.deepEqual(resolvePlannerLocation(parsePlannerLocation(groceriesPath(week.id)), [week], week.id), { kind: "groceries", week });
  const archived = { ...week, status: "archived" };
  assert.equal(resolvePlannerLocation(parsePlannerLocation(groceriesPath(archived.id)), [archived], archived.id).kind, "groceries");
});

test("invalid and cross-week Recipe targets never select another meal", () => {
  const week = fixture();
  const missing = resolvePlannerLocation(parsePlannerLocation(`/weeks/${week.id}/recipes/missing`), [week], week.id);
  assert.equal(missing.kind, "unavailable");
  assert.equal(missing.week?.id, week.id);
  const crossWeek = resolvePlannerLocation(parsePlannerLocation("/weeks/2026-07-13/recipes/meal-1"), [week], week.id);
  assert.equal(crossWeek.kind, "unavailable");
  const archived = structuredClone(week);
  archived.status = "archived";
  assert.equal(resolvePlannerLocation(parsePlannerLocation(recipePath(archived.id, archived.data.meals[0].id)), [archived], archived.id).kind, "unavailable");
});

test("only canonical selected-week paths parse, and retired Day URLs cannot fall back to Week", () => {
  const week = fixture();
  const retiredDay = parsePlannerLocation(`/weeks/${week.id}/day/${week.data.meals[0].date}`);
  assert.deepEqual(retiredDay, { kind: "retired-day" });
  assert.deepEqual(resolvePlannerLocation(retiredDay, [week], week.id), {
    kind: "unavailable",
    week: null,
    message: "Day is no longer a planner destination.",
  });
});

test("root restoration remembers a validated canonical destination and migrates legacy Week values", () => {
  const week = fixture();
  const meal = week.data.meals[0];
  const resolvedRecipe = resolvePlannerLocation(parsePlannerLocation(recipePath(week.id, meal.id)), [week], week.id);
  const remembered = rememberedPlannerLocation(resolvedRecipe);
  assert.equal(LAST_VALID_WEEK_STORAGE_KEY, "weekly-recipe-planner.last-valid-week");
  assert.deepEqual(remembered, { kind: "recipe", weekId: week.id, mealId: meal.id });
  assert.equal(plannerLocationPath(remembered), recipePath(week.id, meal.id));
  assert.deepEqual(parseRememberedPlannerLocation(serializeRememberedPlannerLocation(remembered)), remembered);
  assert.deepEqual(parseRememberedPlannerLocation(week.id), { kind: "week", weekId: week.id });
  assert.equal(parseRememberedPlannerLocation('{"kind":"recipe","weekId":"bad"}'), null);
});
